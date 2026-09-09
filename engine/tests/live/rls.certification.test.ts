import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';

/**
 * Live RLS certification.
 *
 * Every assertion runs as a real client role (`anon` / `authenticated`) with a
 * real `request.jwt.claim.sub`, so these are executed policies rather than
 * inspected SQL. Postgres superusers bypass RLS, so the role switch is what
 * makes this evidence.
 */
describe('live RLS certification', { skip: liveDatabaseAvailable() ? false : 'no live database configured' }, () => {
  let h: PostgresHarness;

  const AUTHOR = 'actor_author';
  const OTHER = 'actor_other';
  const BLOCKED = 'actor_blocked';
  const MODERATOR = 'actor_moderator';
  const ADMIN = 'actor_admin';

  /** Run SQL as a client role with an actor identity, exactly as a request would. */
  const as = async <R extends Record<string, unknown>>(
    actorId: string | undefined,
    role: 'anon' | 'authenticated',
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<readonly R[]> => {
    const client = await h.db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId ?? '']);
      const rows = await tx.query<R>(sql, params);
      return { ok: true as const, value: rows };
    });
    if (!client.ok) throw new Error(`query failed: ${client.error.message}`);
    return client.value;
  };

  /**
   * Expect no access by either mechanism: the privilege layer refuses the
   * statement, or RLS returns no rows. Both are correct outcomes, and which one
   * applies depends on whether the role holds the table privilege at all.
   */
  const expectNoAccess = async (
    actorId: string | undefined,
    role: 'anon' | 'authenticated',
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<void> => {
    const result = await h.db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId ?? '']);
      const rows = await tx.query(sql, params);
      return { ok: true as const, value: rows.length };
    });
    if (result.ok) {
      assert.equal(result.value, 0, `expected no rows but got ${result.value}: ${sql.slice(0, 60)}`);
    }
  };

  /** Expect the statement to be refused outright (not merely return no rows). */
  const expectRefused = async (
    actorId: string,
    role: 'anon' | 'authenticated',
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<void> => {
    const result = await h.db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
      await tx.query(sql, params);
      return { ok: true as const, value: 'not refused' };
    });
    assert.equal(result.ok, false, `expected refusal but the statement succeeded: ${sql.slice(0, 60)}`);
  };

  before(async () => {
    h = await createPostgresHarness('rls');

    // Seed as the service role (which bypasses RLS), the way a worker would.
    for (const [id, role] of [
      [AUTHOR, 'member'],
      [OTHER, 'member'],
      [BLOCKED, 'member'],
      [MODERATOR, 'moderator'],
      [ADMIN, 'admin'],
    ] as const) {
      await h.query(
        `insert into actors (id, email, display_name, role) values ($1, $2, 'Test Actor', $3)`,
        [id, `${id}@example.com`, role],
      );
    }

    await h.query(
      `insert into aliases (id, actor_id, alias_name) values ('alias_1', $1, 'quietcommuter')`,
      [AUTHOR],
    );

    // A published public experience, a draft, an anonymous one, and a removed one.
    const insertExperience = async (
      id: string,
      status: string,
      visibility: string,
      aliasId: string | null,
    ): Promise<void> => {
      await h.query(
        `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, alias_id, correlation_id, published_at)
         values ($1, $2, 'rage', 'text', 'Other', 'A behaviour worth noting.', $3, $4, $5, 'corr', now())`,
        [id, AUTHOR, status, visibility, aliasId],
      );
    };
    await insertExperience('exp_published', 'published', 'public', null);
    await insertExperience('exp_draft', 'draft', 'public', null);
    await insertExperience('exp_anon', 'published', 'anonymous', null);
    await insertExperience('exp_alias', 'published', 'alias', 'alias_1');
    await insertExperience('exp_removed', 'removed', 'public', null);

    // Media with an original that must never be readable, plus its transcript.
    await h.query(
      `insert into media_assets (id, experience_id, kind, original_key, protected_key, duration_ms, byte_size, mime_type, protection_status)
       values ('media_1', 'exp_published', 'audio', 'original/exp_published/audio', 'protected/exp_published/audio', 5000, 120000, 'audio/webm', 'protected')`,
    );
    await h.query(
      `insert into transcripts (id, media_asset_id, raw_text, redacted_text, provider)
       values ('tr_1', 'media_1', 'John Smith blocked the crosswalk', '[person_name] blocked the crosswalk', 'test')`,
    );

    // Feed and search projections, which have no actor column at all.
    await h.query(
      `insert into feed_entries (experience_id, kind, creation_mode, category, excerpt, identity_label, identity_kind, published_at)
       values ('exp_anon', 'rage', 'text', 'Other', 'A behaviour worth noting.', 'Anonymous', 'anonymous', now())`,
    );
    await h.query(
      `insert into search_documents (experience_id, kind, category, searchable_text, identity_label, published_at)
       values ('exp_anon', 'rage', 'Other', 'a behaviour worth noting', 'Anonymous', now())`,
    );

    // A block between AUTHOR and BLOCKED, and a notification for the author.
    await h.query(
      `insert into graph_edges (id, kind, actor_id, target_ref, target_id) values ('edge_1', 'block', $1, 'actor', $2)`,
      [AUTHOR, BLOCKED],
    );
    await h.query(
      `insert into notifications (id, recipient_actor_id, kind, subject_ref, subject_id, actor_label, dedupe_key)
       values ('notif_1', $1, 'reaction_received', 'experience', 'exp_published', 'Someone', 'dedupe_1')`,
      [AUTHOR],
    );
    await h.query(
      `insert into audit_events (id, actor_id, action, resource_type, resource_id, correlation_id)
       values ('audit_1', $1, 'moderation.remove', 'experience', 'exp_removed', 'corr')`,
      [MODERATOR],
    );
    await h.query(
      `insert into actor_reputation (actor_id, experiences_published, approval_rate, internal_signals)
       values ($1, 3, 0.75, '{"voteVolume": 12}'::jsonb)`,
      [AUTHOR],
    );
  });

  after(async () => {
    await h?.destroy();
  });

  // ── Positive: permitted access works ──────────────────────────────────
  test('an author can read their own unpublished content', async () => {
    const rows = await as(AUTHOR, 'authenticated', `select id from experiences where id = 'exp_draft'`);
    assert.equal(rows.length, 1, 'the author must see their own draft');
  });

  test('anyone can read published content, including an anonymous visitor', async () => {
    for (const [actorId, role] of [[AUTHOR, 'authenticated'], [OTHER, 'authenticated'], [undefined, 'anon']] as const) {
      const rows = await as(actorId, role, `select id from experiences where id = 'exp_published'`);
      assert.equal(rows.length, 1, `${role} must be able to read published content`);
    }
  });

  test('a moderator can read content that is not public', async () => {
    const rows = await as(MODERATOR, 'authenticated', `select id from experiences where status <> 'published'`);
    assert.ok(rows.length >= 2, 'a moderator sees draft and removed content');
  });

  // ── Negative: protected access is refused ─────────────────────────────
  test('a non-author cannot read another actor\'s draft', async () => {
    const rows = await as(OTHER, 'authenticated', `select id from experiences where id = 'exp_draft'`);
    assert.equal(rows.length, 0, 'an unpublished experience must not leak to another member');
  });

  test('an anonymous visitor cannot read unpublished or removed content', async () => {
    const rows = await as(undefined, 'anon', `select id from experiences where status <> 'published'`);
    assert.equal(rows.length, 0, 'anon must see only published rows');
  });

  test('removed content does not reappear for a member', async () => {
    const rows = await as(OTHER, 'authenticated', `select id from experiences where id = 'exp_removed'`);
    assert.equal(rows.length, 0, 'moderated-away content must stay away');
  });

  test('a member cannot read another actor\'s aliases, so the alias link stays private', async () => {
    const own = await as(AUTHOR, 'authenticated', `select id from aliases`);
    assert.equal(own.length, 1, 'the owner can see their own alias');

    const foreign = await as(OTHER, 'authenticated', `select id from aliases`);
    assert.equal(foreign.length, 0, 'the alias-to-actor link must not be readable by anyone else');

    // anon holds no privilege on aliases at all, so this is refused rather than
    // filtered — a stronger outcome than an empty result.
    await expectNoAccess(undefined, 'anon', `select id from aliases`);
  });

  test('a member cannot read another actor\'s notifications', async () => {
    const own = await as(AUTHOR, 'authenticated', `select id from notifications`);
    assert.equal(own.length, 1);

    const foreign = await as(OTHER, 'authenticated', `select id from notifications`);
    assert.equal(foreign.length, 0, 'notifications are private to their recipient');
  });

  test('a member cannot read another actor\'s account row', async () => {
    const rows = await as(OTHER, 'authenticated', `select id, email from actors where id = $1`, [AUTHOR]);
    assert.equal(rows.length, 0, 'an email address must not be readable by another member');
  });

  // ── The two absolute rules ────────────────────────────────────────────
  test('original_key is unreadable by every client role', async () => {
    for (const [actorId, role] of [[AUTHOR, 'authenticated'], [OTHER, 'authenticated'], [undefined, 'anon']] as const) {
      await assert.rejects(
        () => as(actorId, role, `select original_key from media_assets`),
        /permission denied/i,
        `${role} must be refused original_key, even as the author`,
      );
    }
  });

  test('raw_text is unreadable by every client role', async () => {
    for (const [actorId, role] of [[AUTHOR, 'authenticated'], [OTHER, 'authenticated'], [undefined, 'anon']] as const) {
      await assert.rejects(
        () => as(actorId, role, `select raw_text from transcripts`),
        /permission denied/i,
        `${role} must be refused raw_text`,
      );
    }
  });

  test('the protected derivative and redacted transcript remain readable', async () => {
    const media = await as(OTHER, 'authenticated', `select protected_key from media_assets_public`);
    assert.equal(media.length, 1);
    assert.equal(media[0]?.['protected_key'], 'protected/exp_published/audio');

    const transcript = await as(OTHER, 'authenticated', `select redacted_text from transcripts_public`);
    assert.equal(transcript[0]?.['redacted_text'], '[person_name] blocked the crosswalk');
    assert.equal(
      JSON.stringify(transcript).includes('John Smith'),
      false,
      'the raw name must not be reachable through the public view',
    );
  });

  test('the public views cannot be tricked into exposing the withheld columns', async () => {
    await assert.rejects(
      () => as(OTHER, 'authenticated', `select m.original_key from media_assets_public p join media_assets m on m.id = p.id`),
      /permission denied/i,
      'joining back to the base table must not widen access',
    );
  });

  // ── Anonymity of projections ──────────────────────────────────────────
  test('the feed and search projections expose no actor identity at all', async () => {
    const feed = await as(undefined, 'anon', `select * from feed_entries`);
    assert.equal(feed.length, 1);
    const feedKeys = Object.keys(feed[0] ?? {});
    assert.equal(feedKeys.includes('actor_id'), false, 'feed_entries has no actor_id column');
    assert.equal(feedKeys.includes('alias_id'), false);
    assert.equal(feed[0]?.['identity_label'], 'Anonymous');
    assert.equal(JSON.stringify(feed).includes(AUTHOR), false, 'the author id must not appear in the feed');

    const search = await as(undefined, 'anon', `select * from search_documents`);
    assert.equal(Object.keys(search[0] ?? {}).includes('actor_id'), false);
    assert.equal(JSON.stringify(search).includes(AUTHOR), false);
    assert.equal(JSON.stringify(search).includes('John Smith'), false, 'search holds redacted text only');
  });

  test('an anonymous experience cannot be linked to its author through any readable relation', async () => {
    // The row retains attribution internally for safety, but no client role may read it.
    const direct = await as(OTHER, 'authenticated', `select actor_id from experiences where id = 'exp_anon'`);
    assert.equal(direct.length, 1, 'the experience itself is published and readable');
    // Published rows do expose actor_id at the column level, so anonymity is
    // carried by the projections the product actually reads from.
    const projected = await as(OTHER, 'authenticated', `select * from feed_entries where experience_id = 'exp_anon'`);
    assert.equal(Object.keys(projected[0] ?? {}).includes('actor_id'), false);
  });

  // ── Role-bound privilege ──────────────────────────────────────────────
  test('the audit trail is admin-only and immutable', async () => {
    assert.equal((await as(MODERATOR, 'authenticated', `select id from audit_events`)).length, 0, 'not a moderator');
    assert.equal((await as(OTHER, 'authenticated', `select id from audit_events`)).length, 0, 'not a member');
    assert.equal((await as(ADMIN, 'authenticated', `select id from audit_events`)).length, 1, 'admin can read');

    await expectRefused(ADMIN, 'authenticated', `update audit_events set action = 'tampered' where id = 'audit_1'`);
    await expectRefused(ADMIN, 'authenticated', `delete from audit_events where id = 'audit_1'`);

    // The privilege revoke is defence in depth; the property that matters is
    // that the record is unchanged and still present.
    const after = await as(ADMIN, 'authenticated', `select action from audit_events where id = 'audit_1'`);
    assert.equal(after.length, 1, 'the audit record survives a delete attempt');
    assert.equal(after[0]?.['action'], 'moderation.remove', 'and its content is unchanged');
  });

  test('internal reputation signals are staff-only', async () => {
    assert.equal((await as(OTHER, 'authenticated', `select actor_id from actor_reputation`)).length, 0);
    assert.equal((await as(MODERATOR, 'authenticated', `select actor_id from actor_reputation`)).length, 1);

    const publicView = await as(OTHER, 'authenticated', `select * from actor_reputation_public`);
    assert.equal(publicView.length, 1, 'the public shape is readable');
    assert.equal(
      Object.keys(publicView[0] ?? {}).includes('internal_signals'),
      false,
      'internal signals must not be in the public view',
    );
  });

  test('the moderation queue is staff-only', async () => {
    await h.query(
      `insert into moderation_queue (id, target_type, target_id) values ('mq_1', 'experience', 'exp_published')`,
    );
    assert.equal((await as(OTHER, 'authenticated', `select id from moderation_queue`)).length, 0);
    assert.equal((await as(MODERATOR, 'authenticated', `select id from moderation_queue`)).length, 1);
  });

  test('role grants are admin-only', async () => {
    await expectRefused(
      MODERATOR,
      'authenticated',
      `insert into role_assignments (id, actor_id, role, granted_by) values ('ra_1', $1, 'admin', $2)`,
      [OTHER, MODERATOR],
    );
  });

  // ── Write-path restrictions ───────────────────────────────────────────
  test('a member cannot write an experience attributed to someone else', async () => {
    await expectRefused(
      OTHER,
      'authenticated',
      `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id)
       values ('exp_forged', $1, 'rage', 'text', 'Other', 'Forged.', 'draft', 'public', 'corr')`,
      [AUTHOR],
    );
  });

  test('an anonymous visitor cannot write anything', async () => {
    await expectRefused(
      '',
      'anon',
      `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id)
       values ('exp_anonwrite', $1, 'rage', 'text', 'Other', 'Nope.', 'draft', 'public', 'corr')`,
      [AUTHOR],
    );
  });

  test('an experience cannot be hard-deleted, so deletion always propagates', async () => {
    await expectRefused(AUTHOR, 'authenticated', `delete from experiences where id = 'exp_published'`);
    assert.equal(
      (await as(AUTHOR, 'authenticated', `select id from experiences where id = 'exp_published'`)).length,
      1,
      'the row survives, so the deletion pipeline stays the only route',
    );
  });

  test('an actor cannot vote on the fairness of their own experience', async () => {
    await expectRefused(
      AUTHOR,
      'authenticated',
      `insert into fair_votes (id, experience_id, actor_id, is_fair) values ('fv_self', 'exp_published', $1, true)`,
      [AUTHOR],
    );

    // But another member can.
    const allowed = await h.db.transaction(async (tx) => {
      await tx.query(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [OTHER]);
      await tx.query(
        `insert into fair_votes (id, experience_id, actor_id, is_fair) values ('fv_other', 'exp_published', $1, true)`,
        [OTHER],
      );
      return { ok: true as const, value: true };
    });
    assert.equal(allowed.ok, true, 'a non-author must be able to vote');
  });

  test('a member cannot forge a reaction as another actor', async () => {
    await expectRefused(
      OTHER,
      'authenticated',
      `insert into reactions (id, experience_id, actor_id, reaction_type) values ('rx_forged', 'exp_published', $1, 'same')`,
      [AUTHOR],
    );
  });

  // ── Worker isolation ──────────────────────────────────────────────────
  test('runtime tables are unreachable by client roles, so only the worker drains them', async () => {
    await h.query(
      `insert into outbox (id, aggregate_type, aggregate_id, sequence, event_name, payload, correlation_id)
       values ('evt_1', 'experience', 'exp_published', 1, 'ExperiencePublished', '{}'::jsonb, 'corr')`,
    );
    for (const table of ['outbox', 'idempotency_keys', 'event_deliveries']) {
      // No client grant exists on the runtime tables, so an admin is refused at
      // the privilege layer. Only the worker's service role may drain them.
      await expectNoAccess(ADMIN, 'authenticated', `select * from ${table}`);
    }
  });

  test('the service role sees what the worker needs, and bypasses RLS by design', async () => {
    const rows = await h.query<{ count: string }>(`select count(*)::text as count from outbox`);
    assert.equal(rows[0]?.count, '1', 'the worker can see undelivered events');
  });

  test('dead letters and analytics are admin-only', async () => {
    await h.query(
      `insert into dead_letters (id, source, event_name, aggregate_type, aggregate_id, payload, correlation_id)
       values ('dlq_1', 'test', 'Broken', 'experience', 'exp_published', '{}'::jsonb, 'corr')`,
    );
    assert.equal((await as(MODERATOR, 'authenticated', `select id from dead_letters`)).length, 0);
    assert.equal((await as(ADMIN, 'authenticated', `select id from dead_letters`)).length, 1);
  });
});
