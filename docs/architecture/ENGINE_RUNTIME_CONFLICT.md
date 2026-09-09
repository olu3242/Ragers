# Ragers — runtime collision disposition

**Classification:** Internal.
**Owner decision recorded here.** Inspected only far enough to classify overlap;
neither runtime was rewritten in this slice.

## Decision

**The certified TypeScript runtime in `engine/` is authoritative.**

`origin/feat/experience-integrity-engine` (PR #6) must **not** become a second
authoritative runtime.

## What PR #6 contains

| File | Lines | Substance |
|---|---|---|
| `engine/experience-integrity-engine.js` | 432 | in-memory `Map` engine: submit, corroborate, addEvidence, dispute, resolve, clusters, confidence scoring |
| `engine/durable-runtime.js` | 113 | whole-file JSON snapshot persistence + an in-process outbox array |
| `server.js` | 104 | bespoke HTTP server |
| `app-runtime.js`, `tests-integrity.js`, `tests-runtime.js` | — | client glue and its own tests |

It collides on the **`engine/` path**: `engine/durable-runtime.js` and
`engine/experience-integrity-engine.js` would land inside the TypeScript package
directory. Whichever merges second conflicts structurally, not just textually.

## Overlapping responsibilities

| PR #6 | Authoritative equivalent | Engine |
|---|---|---|
| `submit()` | `experience.create` + screening consumer | E1, E5 |
| `corroborate()` | `corroboration.create` | E6 |
| `addEvidence()` | `evidence.attach` | E4 |
| `dispute()` | `dispute.open` + `dispute.review` | E10 |
| `resolve()` | `resolution.report` | E10 |
| clusters, `#recalculateCluster` | matching engine + cluster counters | E7 |
| confidence scoring | signal snapshots + trust assessments | E8, E4 |
| coordination-window detection | `detectCoordinatedBurst` | E4 |
| `DurableIntegrityRuntime` | Postgres + transactional outbox + leased jobs | shared spine |

## Reusable / migration candidates

1. **`fingerprint()`** — SHA-256 over `type | entityId | topicId | city |
   normalizedText`. A content fingerprint for near-duplicate detection, and the
   authoritative engine has **no equivalent**. Genuinely useful: it would catch the
   same account posted twice, which matching currently does not. Worth porting as
   an E3/E7 input.
2. **Independent-signal thresholds** (`emergingIndependentSignals: 5`,
   `highConfidenceIndependentSignals: 20`) — a tiered reading of corroboration
   volume. The authoritative engine has `trendMinVolume` but no tiers. Worth
   considering as an E8 presentation input, *not* as a confidence score.
3. **`relatedSimilarity: 0.45`** — a calibration data point to compare against
   `SEMANTIC_RELATED_THRESHOLD = 0.3`.

## Discard candidates, with reasons

1. **`DurableIntegrityRuntime`** — persistence is a whole-file JSON snapshot
   rewritten on every transaction. Two concurrent writers lose each other's work
   entirely; there is no row-level concurrency control, no RLS, and no way to run
   more than one process. The authoritative spine solves all three and is certified
   against a live Postgres.
2. **`server.js`** — superseded by the Next.js host, which the browser suite drives
   as a production build.
3. **`dispute()` / `resolve()`** — **these contradict a certified rule.** Both are
   unguarded: any caller may transition an experience to `resolved`, and there is
   no notion of experiencer consent. The authoritative contract is that only the
   people it happened to can resolve, and that an organization-sourced resolution is
   refused outright. Porting these would reintroduce exactly the failure the ESE
   exists to prevent.
4. **In-memory `Map` aggregates** — the authoritative in-memory adapter already
   provides this for tests, behind the same port as Postgres and certified at
   parity with it.

## Merge risks

- **Path collision** on `engine/` — structural, not textual. Must be resolved by
  moving or dropping PR #6's files before either branch merges.
- **Two dispute/resolve semantics** — if PR #6's version survives anywhere reachable,
  the "a response is not a resolution" rule is bypassable.
- **Two event infrastructures** — its in-process outbox array has no transactional
  guarantee, no lease, no dead letter and no replay safety.
- **Divergent vocabulary** — `topicId`, `type`, `experienceConfidence` versus
  `issueTypeId`, `kind`, named signal metrics. Silent field drift is likely if both
  exist.

## Recommended path

1. **Do not merge PR #6 as a runtime.** Close it, or retarget it to a
   non-`engine/` path as a reference.
2. **Port `fingerprint()`** into E3 as a near-duplicate input, behind the existing
   ports and with its own tests. This is the only piece with clear standalone value.
3. **Evaluate the independent-signal tiers** as an E8 presentation concern —
   labelled tiers over `uniqueExperiencers`, never a composite confidence number.
4. **Discard everything else**, recording the dispute/resolve contradiction in the
   PR so the reason is on the record rather than in somebody's memory.

Nothing in this slice ports anything: this document is the disposition, and the
port is its own change with its own tests.
