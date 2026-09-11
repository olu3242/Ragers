import type { GateResult, GateScope } from './harness.ts';

/**
 * The release readiness contract — Phase 99.
 *
 * Eight dimensions, tracked independently, and the whole point of the phase is one rule:
 *
 * > **Never collapse missing external evidence into code readiness.**
 *
 * Every previous band produced a status of the form "READY, or READY with a named blocker". That
 * worked because each band asked one question. A release asks eight, and they fail for unrelated
 * reasons — the code can be perfect while no deployment target exists, and a deployed system can be
 * running while its browser tests are red. A single aggregate status over those eight would have to
 * pick one to be about, and whichever it picked would make the others invisible.
 *
 * ## Why `BLOCKED` and `NOT_READY` are different values
 *
 * `NOT_READY` means **we looked and it is not good enough** — a gate failed. `BLOCKED` means **we
 * could not look**, because the evidence needs something this environment does not have. Collapsing
 * them would be the specific dishonesty this contract exists to prevent: a deployment nobody can
 * attempt would read as a deployment that failed, and the fix for those two is not the same.
 *
 * `READY_WITH_CONDITIONS` is for a dimension that is genuinely ready *given* something stated — the
 * benchmark aggregation is correct and produces nothing until there is volume. The condition is
 * named on the dimension, so nobody has to remember it.
 */

export type ReadinessValue = 'READY' | 'READY_WITH_CONDITIONS' | 'BLOCKED' | 'NOT_READY';

export type ReleaseDimension =
  | 'CODE_READY'
  | 'SECURITY_READY'
  | 'BROWSER_READY'
  | 'OPERATIONS_READY'
  | 'DATA_READY'
  | 'PROVIDER_READY'
  | 'DEPLOYMENT_READY'
  | 'ROLLBACK_READY';

export const RELEASE_DIMENSIONS: readonly ReleaseDimension[] = [
  'CODE_READY',
  'SECURITY_READY',
  'BROWSER_READY',
  'OPERATIONS_READY',
  'DATA_READY',
  'PROVIDER_READY',
  'DEPLOYMENT_READY',
  'ROLLBACK_READY',
];

/**
 * Which dimensions a controlled validation requires.
 *
 * The four that are about *this codebase*: does it work, is it safe, does it work in a browser, can
 * it be operated. Deployment, rollback, data volume and live providers are all about an environment
 * somebody else has to provide, and requiring them for a controlled validation would mean nothing
 * could ever be validated before it was deployed — which is backwards.
 */
export const CONTROLLED_VALIDATION_REQUIRES: readonly ReleaseDimension[] = [
  'CODE_READY',
  'SECURITY_READY',
  'BROWSER_READY',
  'OPERATIONS_READY',
];

/**
 * Which dimensions a production pilot requires: all eight.
 *
 * A pilot puts real people's accounts of real things into a system, and every one of the eight is
 * load-bearing for that. There is no subset of these that makes a pilot responsible.
 */
export const PRODUCTION_PILOT_REQUIRES: readonly ReleaseDimension[] = RELEASE_DIMENSIONS;

export interface DimensionReading {
  readonly dimension: ReleaseDimension;
  readonly value: ReadinessValue;
  /** What was actually checked, in words. */
  readonly evidence: string;
  /** What is missing, when something is. Absent exactly when `value` is `READY`. */
  readonly missing?: string;
  /** The condition, when the value is `READY_WITH_CONDITIONS`. */
  readonly condition?: string;
}

/** Which gate scopes feed which dimension. Everything else is judged from the environment. */
const SCOPES_FOR: Readonly<Partial<Record<ReleaseDimension, readonly GateScope[]>>> = {
  CODE_READY: ['engine', 'experience_signal_engine', 'experience_loop', 'trust_quality'],
  SECURITY_READY: ['governance_action'],
  OPERATIONS_READY: ['operational_integrity'],
};

/** Requirements a gate declares, matched by substring, for the dimensions that are not scope-shaped. */
const REQUIREMENTS_FOR: Readonly<Partial<Record<ReleaseDimension, readonly string[]>>> = {
  SECURITY_READY: ['authorization', 'security', 'privacy'],
  BROWSER_READY: ['browser'],
  OPERATIONS_READY: ['retry', 'concurrency', 'backup', 'schema/migrations'],
  DEPLOYMENT_READY: ['deployment'],
  ROLLBACK_READY: ['rollback'],
};

const valueFrom = (relevant: readonly GateResult[]): ReadinessValue => {
  if (relevant.length === 0) return 'BLOCKED';
  if (relevant.some((gate) => gate.status === 'failed')) return 'NOT_READY';
  // A dimension whose only evidence is blocked is blocked. Not `READY_WITH_CONDITIONS`: a condition
  // is something stated and understood, and an absent environment is neither.
  if (relevant.every((gate) => gate.status === 'blocked')) return 'BLOCKED';
  if (relevant.some((gate) => gate.status === 'blocked')) return 'READY_WITH_CONDITIONS';
  return 'READY';
};

/**
 * Which dimension a gate belongs to — **exactly one**.
 *
 * ## The defect this function exists because of
 *
 * The first version asked each dimension "which gates match me", and a gate could match several.
 * `GateScope` is optional and the natural default is `'engine'`, so the *deployment* and *rollback*
 * gates — which declare a requirement and no scope — counted as engine-scoped, and therefore fed
 * `CODE_READY`. Two blocked external gates turned `CODE_READY` from `READY` into
 * `READY_WITH_CONDITIONS`.
 *
 * That is exactly the failure this whole phase exists to prevent, in the function meant to prevent
 * it: **a missing external blocker bleeding into code readiness.** It would have been invisible in
 * a ledger — `READY_WITH_CONDITIONS` reads plausible — and it would have understated the code while
 * overstating nothing, which is the direction nobody checks.
 *
 * So ownership is now single and explicit, and **requirement beats scope** because a requirement is
 * the more specific statement: a gate that says it is about `deployment` is about deployment
 * whatever scope it carries.
 */
const ownerOf = (gate: GateResult): ReleaseDimension | undefined => {
  for (const dimension of RELEASE_DIMENSIONS) {
    const requirements = REQUIREMENTS_FOR[dimension] ?? [];
    if (requirements.some((requirement) => gate.requirement.includes(requirement))) return dimension;
  }
  for (const dimension of RELEASE_DIMENSIONS) {
    const scopes = SCOPES_FOR[dimension] ?? [];
    if (scopes.length > 0 && scopes.includes(gate.scope ?? 'engine')) return dimension;
  }
  return undefined;
};

const gatesFor = (results: readonly GateResult[], dimension: ReleaseDimension): readonly GateResult[] =>
  results.filter((gate) => ownerOf(gate) === dimension);

export interface ReleaseInputs {
  readonly results: readonly GateResult[];
  /** Whether an environment has real object storage behind `original_key`. */
  readonly objectStorageReady: boolean;
  /** Whether any comparison set has the twenty distinct contributors a benchmark needs. */
  readonly benchmarkDataReady: boolean;
  /** Whether a live model, transcription or PII provider is configured. */
  readonly liveProvidersReady: boolean;
}

/**
 * Read the eight dimensions from the gates and the environment.
 *
 * Derived, never asserted. A dimension somebody could set by hand would be set to `READY` by
 * somebody in a hurry, which is the whole failure mode this contract exists to make impossible.
 */
export const readDimensions = (inputs: ReleaseInputs): readonly DimensionReading[] => {
  const readings: DimensionReading[] = [];

  for (const dimension of RELEASE_DIMENSIONS) {
    if (dimension === 'DATA_READY' || dimension === 'PROVIDER_READY') continue;

    const relevant = gatesFor(inputs.results, dimension);
    const value = valueFrom(relevant);
    const blocked = relevant.filter((gate) => gate.status === 'blocked');
    const failed = relevant.filter((gate) => gate.status === 'failed');

    readings.push({
      dimension,
      value,
      evidence:
        relevant.length === 0
          ? 'No gate covers this dimension, so nothing has been checked.'
          : `${relevant.length} gate(s): ${relevant.filter((gate) => gate.status === 'passed').length} passed, ${failed.length} failed, ${blocked.length} blocked.`,
      ...(value === 'READY'
        ? {}
        : {
            missing:
              failed.length > 0
                ? failed.map((gate) => gate.name).join('; ')
                : blocked.length > 0
                  ? blocked.map((gate) => `${gate.name}: ${gate.blockedBy ?? gate.detail}`).join('; ')
                  : 'no gate covers this dimension',
          }),
      ...(value === 'READY_WITH_CONDITIONS'
        ? { condition: `Passes except for ${blocked.length} blocked gate(s), each waiting on an absent environment.` }
        : {}),
    });
  }

  // ── the two dimensions no gate can answer ──────────────────────────────
  //
  // These are about *volume* and *credentials*, and a gate that passed against a fake would be
  // asserting the opposite of what the dimension asks. So they are read from the environment and
  // are `BLOCKED` by default — the honest position when nothing has been provided.
  readings.push({
    dimension: 'DATA_READY',
    value: inputs.benchmarkDataReady ? 'READY' : 'BLOCKED',
    evidence: inputs.benchmarkDataReady
      ? 'An environment reports comparison sets with enough distinct contributors.'
      : 'The aggregation, the floors and the suppression are all certified and produce no output.',
    ...(inputs.benchmarkDataReady
      ? {}
      : {
          missing:
            'Twenty distinct contributors per comparison set. Certified code over absent data is not a benchmark, and a gate that passed against seeded volume would be certifying the seed.',
        }),
  });

  readings.push({
    dimension: 'PROVIDER_READY',
    value: inputs.liveProvidersReady ? 'READY' : 'BLOCKED',
    evidence: inputs.liveProvidersReady
      ? 'Live transcription, PII and model providers are configured.'
      : 'The ports and their fail-closed behaviour are certified against fakes. `live: false` is what says so.',
    ...(inputs.liveProvidersReady
      ? {}
      : {
          missing:
            'Credentials for a transcription/PII provider and a model provider. An interface is not a certified provider.',
        }),
  });

  // Object storage is an operations fact rather than a dimension of its own, so it conditions
  // OPERATIONS_READY rather than adding a ninth. Retention decides, holds and records; only the
  // byte deletion is absent, and a dimension that ignored that would be claiming a deletion
  // nothing performed.
  if (!inputs.objectStorageReady) {
    const operations = readings.find((reading) => reading.dimension === 'OPERATIONS_READY');
    if (operations && operations.value === 'READY') {
      readings[readings.indexOf(operations)] = {
        ...operations,
        value: 'READY_WITH_CONDITIONS',
        condition:
          'Retention states its ceilings, enforces its holds, decides expiry and writes its ledger. Deleting remote bytes reports object_storage_blocked until a bucket exists.',
      };
    }
  }

  return readings.sort(
    (left, right) => RELEASE_DIMENSIONS.indexOf(left.dimension) - RELEASE_DIMENSIONS.indexOf(right.dimension),
  );
};

export type ReleaseDecision = 'GO' | 'NO_GO';

export interface ReleaseVerdict {
  readonly decision: ReleaseDecision;
  /** Which required dimensions are not `READY` or `READY_WITH_CONDITIONS`. */
  readonly blocking: readonly ReleaseDimension[];
  readonly reason: string;
}

const satisfied = (value: ReadinessValue): boolean =>
  value === 'READY' || value === 'READY_WITH_CONDITIONS';

/**
 * Whether a decision may be GO, given the readings.
 *
 * **A decision cannot be GO while a required dimension is not satisfied**, and there is no
 * override parameter. That absence is the phase: a function with a `force` argument would be
 * called with `force` by somebody under pressure, and the ledger would then say GO about a
 * release nobody had evidence for.
 */
export const decide = (
  readings: readonly DimensionReading[],
  required: readonly ReleaseDimension[],
): ReleaseVerdict => {
  const byDimension = new Map(readings.map((reading) => [reading.dimension, reading]));
  const blocking = required.filter((dimension) => {
    const reading = byDimension.get(dimension);
    return reading === undefined || !satisfied(reading.value);
  });

  if (blocking.length === 0) {
    return {
      decision: 'GO',
      blocking: [],
      reason: `Every required dimension is satisfied: ${required.join(', ')}.`,
    };
  }
  return {
    decision: 'NO_GO',
    blocking,
    reason: `Not satisfied: ${blocking
      .map((dimension) => `${dimension}=${byDimension.get(dimension)?.value ?? 'UNKNOWN'}`)
      .join(', ')}.`,
  };
};

export type ReleaseStatus =
  | 'RAGERS_RC2_READY_FOR_CONTROLLED_VALIDATION'
  | 'RAGERS_RC2_READY_WITH_EXTERNAL_BLOCKERS'
  | 'RAGERS_RC2_NO_GO';

/**
 * The release candidate's own status.
 *
 * Three values, and the middle one is the honest answer for this codebase today: the internal
 * dimensions are certified and the external ones are blocked on things no amount of code will
 * produce. It is deliberately *not* a fourth value meaning "production ready" — RC2 is not that,
 * and there is no value here that could be mistaken for it.
 */
export const releaseStatus = (
  controlled: ReleaseVerdict,
  pilot: ReleaseVerdict,
): ReleaseStatus => {
  if (controlled.decision === 'NO_GO') return 'RAGERS_RC2_NO_GO';
  if (pilot.decision === 'GO') return 'RAGERS_RC2_READY_FOR_CONTROLLED_VALIDATION';
  // Controlled validation may proceed and a pilot may not. Naming the blockers rather than
  // rounding up to ready, or down to no-go.
  return 'RAGERS_RC2_READY_WITH_EXTERNAL_BLOCKERS';
};

/**
 * The absences, as code.
 *
 * `readinessCanBeAsserted` — false. Every dimension is derived from gates and the environment, so
 * there is no field a person can set. A dimension somebody could write would be written `READY`.
 *
 * `codeReadinessAbsorbsAnExternalBlocker` — false, and it is the rule the whole phase is. A missing
 * deployment target must never make CODE_READY anything other than what the code's own gates say,
 * and it must never let the aggregate claim more than the weakest required dimension.
 */
export const readinessCanBeAsserted = (): false => false;
export const codeReadinessAbsorbsAnExternalBlocker = (): false => false;
