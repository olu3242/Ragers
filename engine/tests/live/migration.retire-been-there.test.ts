import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  migrationBody,
  type PostgresHarness,
} from '../support/postgres-harness.ts';

/**
 * The Been There → corroboration backfill, against a real database.
 *
 * A data migration is only proven by rows that existed before it ran, so the
 * harness stops one migration short, seeds the old shape, then applies the
 * migration under test. What matters is that nobody's "this happened to me too"
 * is lost, none is duplicated, and none is invented where the corroboration
 * rules would refuse it.
 */
describe(
  'retiring been_there',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;

    before(async () => {
      h = await createPostgresHarness('beenthere', { upToInclusive: '0005_outbox_sequences.sql' });

      await h.query(`insert into actors (id, email, auth_provider, display_name) values
        ('actor_author', 'author@example.com', 'password', 'Author'),
        ('actor_a',      'a@example.com',      'password', 'A'),
        ('actor_b',      'b@example.com',      'password', 'B'),
        ('actor_rave',   'rave@example.com',   'password', 'Rave author')`);

      await h.query(`insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id, published_at) values
        ('exp_rage', 'actor_author', 'rage', 'text', 'Other', 'The refund never arrived.', 'published', 'public', 'corr_seed', now()),
        ('exp_rave', 'actor_rave',   'rave', 'text', 'Other', 'The refund arrived at once.', 'published', 'public', 'corr_seed', now())`);

      await h.query(`insert into experience_counters (experience_id, been_there, same, fair_point, disagree, fair_yes, fair_no, reply_count) values
        ('exp_rage', 2, 1, 0, 0, 0, 0, 0),
        ('exp_rave', 1, 0, 0, 0, 0, 0, 0)`);

      await h.query(`insert into reactions (id, experience_id, actor_id, reaction_type) values
        -- Two people said it happened to them too.
        ('rx_1', 'exp_rage', 'actor_a',      'been_there'),
        ('rx_2', 'exp_rage', 'actor_b',      'been_there'),
        -- The author tapped their own. There is nothing to migrate: they claimed
        -- it by posting it.
        ('rx_3', 'exp_rage', 'actor_author', 'been_there'),
        -- On a Rave, the same tap means a Re-Rave.
        ('rx_4', 'exp_rave', 'actor_a',      'been_there'),
        -- A response, not a claim. It must survive untouched.
        ('rx_5', 'exp_rage', 'actor_a',      'same')`);

      await h.query(migrationBody('0006_retire_been_there.sql'));
    });

    after(async () => {
      await h?.destroy();
    });

    test('every Been There from someone other than the author became a corroboration', async () => {
      const rows = await h.query<{ experience_id: string; corroborator_id: string; type: string; relationship: string }>(
        `select experience_id, corroborator_id, type, relationship
         from experience_corroborations order by experience_id, corroborator_id`,
      );
      assert.deepEqual(
        rows.map((row) => `${row.experience_id}/${row.corroborator_id}/${row.type}`),
        ['exp_rage/actor_a/re_rage', 'exp_rage/actor_b/re_rage', 'exp_rave/actor_a/re_rave'],
        'a rage becomes a re_rage and a rave a re_rave; the author is excluded',
      );
      for (const row of rows) {
        assert.equal(
          row.relationship,
          'similar_experience',
          'a Been There tap never claimed it was the same incident, so the migration must not claim it either',
        );
      }
    });

    test('the migrated rows carry the engine key, so a later claim lands on them', async () => {
      const ids = await h.query<{ id: string }>(`select id from experience_corroborations order by id`);
      assert.deepEqual(ids.map((row) => row.id), [
        'exp_rage:actor_a',
        'exp_rage:actor_b',
        'exp_rave:actor_a',
      ]);
    });

    test('nothing is double-counted: the reaction rows are gone and the responses remain', async () => {
      const remaining = await h.query<{ reaction_type: string; count: string }>(
        `select reaction_type, count(*)::text as count from reactions group by reaction_type`,
      );
      assert.deepEqual(remaining, [{ reaction_type: 'same', count: '1' }]);
    });

    test('counters are recomputed, with the retired column zeroed', async () => {
      const counters = await h.query<{
        experience_id: string;
        been_there: number;
        re_rage_count: number;
        re_rave_count: number;
        corroborator_count: number;
        same: number;
      }>(`select experience_id, been_there, re_rage_count, re_rave_count, corroborator_count, same
          from experience_counters order by experience_id`);

      assert.deepEqual(counters, [
        { experience_id: 'exp_rage', been_there: 0, re_rage_count: 2, re_rave_count: 0, corroborator_count: 2, same: 1 },
        { experience_id: 'exp_rave', been_there: 0, re_rage_count: 0, re_rave_count: 1, corroborator_count: 1, same: 0 },
      ]);
    });

    test('re-applying the migration changes nothing', async () => {
      // Migrations get re-run — by a restore, by a replay, by a nervous operator.
      await h.query(migrationBody('0006_retire_been_there.sql'));
      assert.equal(
        (await h.query<{ count: string }>(`select count(*)::text as count from experience_corroborations`))[0]?.count,
        '3',
      );
    });
  },
);
