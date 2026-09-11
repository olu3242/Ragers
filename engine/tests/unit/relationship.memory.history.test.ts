import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleGraph,
  degreeOf,
  edgeKeyOf,
  mergeConnections,
  reasonForAssertion,
  MAX_GRAPH_DEPTH,
} from '../../src/domain/relationship.ts';
import {
  actorMemory,
  assembleMemory,
  collectMemoryKeys,
  forbiddenMemoryKeysIn,
  type MemoryEntry,
} from '../../src/domain/memory.ts';
import { changeBetween, changesAcross, rankOrganizations, seriesOf } from '../../src/domain/history.ts';
import { MINIMUM_DISTINCT_CONTRIBUTORS } from '../../src/domain/aggregation.ts';

/**
 * Phases 51–53, as pure domain rules.
 *
 * Each of these is a rule that would be easy to satisfy by accident today and easy to
 * break by accident later, so each is asserted directly rather than through the bus.
 */

// ── P51 the relationship graph ────────────────────────────────────────────
test('a pair connected by two routes is one connection with two reasons', () => {
  // The failure test the phase names: graph duplication. Somebody asserted the pair,
  // and they also landed in the same cluster. That is one connection.
  const connections = mergeConnections([
    { experienceId: 'exp_2', reason: 'same_pattern_asserted', assertedBy: 'actor_1' },
    { experienceId: 'exp_2', reason: 'same_cluster' },
  ]);

  assert.equal(connections.length, 1, 'one connection, not two');
  const [connection] = connections;
  assert.deepEqual(connection?.reasons, ['same_pattern_asserted', 'same_cluster']);
  assert.equal(connection?.assertedByCount, 1);
});

test('several people asserting one pair is one connection and a count of people', () => {
  const connections = mergeConnections([
    { experienceId: 'exp_2', reason: 'same_pattern_asserted', assertedBy: 'actor_1' },
    { experienceId: 'exp_2', reason: 'same_pattern_asserted', assertedBy: 'actor_2' },
    { experienceId: 'exp_2', reason: 'same_occurrence_asserted', assertedBy: 'actor_2' },
  ]);
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.assertedByCount, 2, 'people, not assertions');
  assert.deepEqual(
    connections[0]?.reasons,
    ['same_occurrence_asserted', 'same_pattern_asserted'],
    'most specific reason first',
  );
});

test('a connection carries no trust weight, however many people assert it', () => {
  const connections = mergeConnections(
    Array.from({ length: 100 }, (_, index) => ({
      experienceId: 'exp_2' as const,
      reason: 'same_pattern_asserted' as const,
      assertedBy: `actor_${index}`,
    })),
  );
  assert.equal(connections[0]?.assertedByCount, 100);
  assert.equal(connections[0]?.trustWeight, 0, 'relating a hundred times purchases nothing');
});

test('an undirected pair has one key whichever end names it', () => {
  assert.equal(edgeKeyOf('exp_2', 'exp_1'), edgeKeyOf('exp_1', 'exp_2'));
});

test('an edge discovered from both ends appears once, with the union of reasons', () => {
  // This is what happens on every second hop of a walk, so it is the normal case
  // rather than an edge case.
  const graph = assembleGraph('exp_1', [
    {
      experienceId: 'exp_1',
      depth: 0,
      connections: [{ experienceId: 'exp_2', reasons: ['same_cluster'], assertedByCount: 0, trustWeight: 0 }],
    },
    {
      experienceId: 'exp_2',
      depth: 1,
      connections: [
        { experienceId: 'exp_1', reasons: ['same_pattern_asserted'], assertedByCount: 2, trustWeight: 0 },
      ],
    },
  ]);

  assert.equal(graph.edges.length, 1, 'one edge');
  assert.deepEqual(graph.edges[0]?.reasons, ['same_pattern_asserted', 'same_cluster']);
  assert.equal(graph.edges[0]?.assertedByCount, 2);
  assert.equal(degreeOf(graph, 'exp_1'), 1, 'the degree did not double');
  assert.equal(graph.trustWeight, 0);
});

test('depth is recorded as the shortest path to a node', () => {
  const graph = assembleGraph('exp_1', [
    {
      experienceId: 'exp_1',
      depth: 0,
      connections: [
        { experienceId: 'exp_2', reasons: ['same_cluster'], assertedByCount: 0, trustWeight: 0 },
        { experienceId: 'exp_3', reasons: ['same_cluster'], assertedByCount: 0, trustWeight: 0 },
      ],
    },
    {
      experienceId: 'exp_2',
      depth: 1,
      connections: [{ experienceId: 'exp_3', reasons: ['same_cluster'], assertedByCount: 0, trustWeight: 0 }],
    },
  ]);
  const depths = new Map(graph.nodes.map((node) => [node.experienceId, node.depth]));
  assert.equal(depths.get('exp_1'), 0);
  assert.equal(depths.get('exp_3'), 1, 'reached directly, so depth 1 and not 2');
  assert.ok(MAX_GRAPH_DEPTH === 2, 'the walk is bounded at two hops');
});

test('every relation assertion maps to a named reason', () => {
  assert.equal(reasonForAssertion('same_occurrence'), 'same_occurrence_asserted');
  assert.equal(reasonForAssertion('same_pattern'), 'same_pattern_asserted');
  assert.equal(reasonForAssertion('related_context'), 'related_context_asserted');
});

// ── P52 context memory ────────────────────────────────────────────────────
const entry = (at: number, kind: MemoryEntry['kind'], detail: MemoryEntry['detail'] = {}): MemoryEntry => ({
  at,
  kind,
  by: 'experiencer',
  detail,
});

test('a memory is ordered oldest first, deterministically', () => {
  const memory = assembleMemory(
    'exp_1',
    [entry(300, 'outcome_reported'), entry(100, 'published'), entry(200, 'corroborated')],
    3,
  );
  assert.deepEqual(
    memory.entries.map((item) => item.kind),
    ['published', 'corroborated', 'outcome_reported'],
  );
  assert.equal(memory.firstAt, 100);
  assert.equal(memory.lastAt, 300);
});

test('entries at the same instant order by kind rather than by insertion', () => {
  const forward = assembleMemory('exp_1', [entry(100, 'published'), entry(100, 'corroborated')], 1);
  const reverse = assembleMemory('exp_1', [entry(100, 'corroborated'), entry(100, 'published')], 1);
  assert.deepEqual(
    forward.entries.map((item) => item.kind),
    reverse.entries.map((item) => item.kind),
    'a memory read twice reads the same',
  );
});

test('an empty memory has no first or last, rather than a zero', () => {
  const memory = assembleMemory('exp_1', [], 1);
  assert.equal(memory.firstAt, undefined);
  assert.equal(memory.lastAt, undefined);
  assert.equal(memory.entries.length, 0);
});

test('a memory carries no person and no free text — the keys are refused', () => {
  // The phase's constraint, asserted as a key sweep rather than trusted to review.
  const withActor = assembleMemory('exp_1', [
    { at: 1, kind: 'corroborated', by: 'corroborator', detail: { type: 're_rage' } },
  ], 2);
  assert.deepEqual(forbiddenMemoryKeysIn(withActor), [], 'a well-formed memory leaks nothing');

  const leaky = { ...withActor, entries: [{ ...withActor.entries[0], detail: { corroboratorId: 'actor_9' } }] };
  assert.deepEqual(forbiddenMemoryKeysIn(leaky), ['corroboratorId'], 'and the sweep would catch one that did');

  const quoted = { ...withActor, entries: [{ ...withActor.entries[0], detail: { narrative: 'they said this' } }] };
  assert.deepEqual(forbiddenMemoryKeysIn(quoted), ['narrative'], 'free text is refused too');
});

test('the key sweep walks nested values, not just the top level', () => {
  assert.ok(collectMemoryKeys({ a: { b: [{ actorId: 'x' }] } }).has('actorId'));
});

test('there is no memory of a person', () => {
  assert.equal(actorMemory(), undefined);
});

// ── P53 pattern history ───────────────────────────────────────────────────
const point = (start: number, people: number, newPeople: number, value: number) => ({
  periodStart: start,
  periodEnd: start + 1_000,
  sampleSize: people,
  distinctContributors: people,
  newContributors: newPeople,
  compute: () => value,
});

test('a history is a series in period order', () => {
  const series = seriesOf('org_1', 'resolution_rate', [
    point(2_000, 8, 8, 0.5),
    point(1_000, 8, 8, 0.4),
  ]);
  assert.deepEqual(series.points.map((item) => item.periodStart), [1_000, 2_000]);
});

test('two periods that each clear every floor can still have their change withheld', () => {
  // The failure test the phase names. Eight people then ten, but only two of them
  // new: stating the change describes those two.
  const series = seriesOf('org_1', 'resolution_rate', [point(1_000, 8, 8, 0.4), point(2_000, 10, 2, 0.9)]);
  const [earlier, later] = series.points;
  assert.ok(earlier && later);
  assert.equal(earlier.aggregate.suppressed, false, 'the earlier period is publishable on its own');
  assert.equal(later.aggregate.suppressed, false, 'and so is the later one');

  const change = changeBetween(earlier, later, { higherIsBetter: true });
  assert.equal(change.withheld, true);
  assert.equal(change.withheld && change.reason, 'differencing_risk');
});

test('a change is stated when enough different people separate the periods', () => {
  const series = seriesOf('org_1', 'resolution_rate', [
    point(1_000, 8, 8, 0.4),
    point(2_000, 14, MINIMUM_DISTINCT_CONTRIBUTORS + 1, 0.9),
  ]);
  const [earlier, later] = series.points;
  assert.ok(earlier && later);
  const change = changeBetween(earlier, later, { higherIsBetter: true });
  assert.equal(change.withheld, false);
  assert.equal(change.withheld === false && change.direction, 'improved');
  assert.equal(change.withheld === false && change.delta, 0.5);
});

test('the same movement is an improvement or a worsening depending on the metric', () => {
  const rising = seriesOf('org_1', 'responsiveness', [point(1_000, 8, 8, 100), point(2_000, 14, 9, 200)]);
  const [earlier, later] = rising.points;
  assert.ok(earlier && later);

  const asBetter = changeBetween(earlier, later, { higherIsBetter: true });
  assert.equal(asBetter.withheld, false);
  assert.equal(asBetter.withheld === false ? asBetter.direction : undefined, 'improved');

  const asWorse = changeBetween(earlier, later, { higherIsBetter: false });
  assert.equal(asWorse.withheld, false);
  assert.equal(
    asWorse.withheld === false ? asWorse.direction : undefined,
    'worsened',
    'a rising time-to-respond is not an improvement',
  );
});

test('a change against a suppressed period is not stated at all', () => {
  const series = seriesOf('org_1', 'resolution_rate', [point(1_000, 2, 2, 0.4), point(2_000, 14, 9, 0.9)]);
  const [earlier, later] = series.points;
  assert.ok(earlier && later);
  assert.equal(earlier.aggregate.suppressed, true, 'two people is below the person floor');
  const change = changeBetween(earlier, later, { higherIsBetter: true });
  assert.equal(change.withheld, true);
  assert.equal(change.withheld && change.reason, 'a_period_is_suppressed');
});

test('a small movement is steady rather than a direction', () => {
  const series = seriesOf('org_1', 'resolution_rate', [point(1_000, 8, 8, 0.5), point(2_000, 14, 9, 0.51)]);
  const [earlier, later] = series.points;
  assert.ok(earlier && later);
  const change = changeBetween(earlier, later, { higherIsBetter: true });
  assert.equal(change.withheld === false && change.direction, 'steady');
});

test('changes across a series are one fewer than its points', () => {
  const series = seriesOf('org_1', 'resolution_rate', [
    point(1_000, 8, 8, 0.4),
    point(2_000, 14, 9, 0.6),
    point(3_000, 20, 9, 0.8),
  ]);
  assert.equal(changesAcross(series, { higherIsBetter: true }).length, 2);
});

test('organizations are not ranked against each other', () => {
  assert.equal(rankOrganizations(), undefined);
});
