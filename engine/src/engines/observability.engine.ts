import { eq } from '../ports/store.ts';
import { activeControls } from './control.engine.ts';
import { incidentReport } from './incident.engine.ts';
import type { Engine } from '../engine.ts';

/**
 * Operational observability — Phase 97.
 *
 * Phase 66 built the incident read: dead letters, stale workers, outbox depth, all in one call.
 * This phase asks a different question — not "what can an operator see" but **"can an operator
 * answer the nine questions they will actually be asked?"**
 *
 * ```
 * what failed?                       which engine?              which correlation?
 * was it retried?                    was the effect applied or refused?
 * what is stuck or dead-lettered?    which provider or agent is degraded?
 * is human action required?
 * ```
 *
 * **Every answer comes from a durable record that already exists** — the outbox, the delivery
 * ledger, the audit trail, the health registry, the plan steps, the control table. There is no
 * parallel logging architecture, and the reason is not tidiness: a second record of the same facts
 * is a second version of the truth, and during an incident the two disagreeing is worse than having
 * only one. It is also the failure mode a logging layer has in practice — the logs say one thing,
 * the rows say another, and nobody knows which to trust at the moment it matters.
 *
 * ## Readiness is not health
 *
 * `/api/health` answers "are my dependencies up". **Readiness answers "may this instance serve
 * traffic"**, which is a different question with a different consumer: a load balancer. An instance
 * whose schema is behind is *healthy* — every dependency responds — and must not receive traffic,
 * and a balancer pointed at the health endpoint will send it some. `readiness` below is the
 * distinction, and it is the one gap Phase 97 found rather than composed.
 */

/** The nine questions, as identifiers, so a test can assert each is answered. */
export const OPERATOR_QUESTIONS = [
  'what_failed',
  'which_engine',
  'which_correlation',
  'was_it_retried',
  'effect_applied_or_refused',
  'stuck_or_dead_lettered',
  'degraded_provider_or_agent',
  'human_action_required',
  'may_this_instance_serve_traffic',
] as const;

export type OperatorQuestion = (typeof OPERATOR_QUESTIONS)[number];

export interface FailureAnswer {
  /** What failed, in the words of whatever recorded it. */
  readonly what: string;
  /** The consumer, which is how an operator gets from a failure to an engine. */
  readonly consumer: string;
  /** The event that caused it, so the whole chain is followable. */
  readonly correlationId: string;
  readonly attempts: number;
  readonly retried: boolean;
  /** Whether it is still being retried, has been given up on, or is done. */
  readonly state: string;
  /** True when no further retry will happen on its own. */
  readonly needsAPerson: boolean;
}

export interface ObservabilityAnswers {
  readonly failures: readonly FailureAnswer[];
  /** Jobs that will not move again without somebody doing something. */
  readonly stuck: readonly FailureAnswer[];
  /** Providers reporting anything other than healthy, and agents an operator has paused. */
  readonly degraded: readonly { readonly name: string; readonly kind: 'provider' | 'agent' | 'integration'; readonly detail: string }[];
  /** Approvals whose effect did not follow, from the audit trail. */
  readonly refusedEffects: number;
  readonly humanActionRequired: readonly string[];
  readonly generatedAt: number;
}

/**
 * Answer all nine, from rows.
 *
 * One call rather than nine, for the reason Phase 66 gave: the question an operator is actually
 * asking is whether these are one problem or several, and nine reads at nine instants cannot answer
 * it.
 */
export const answerOperatorQuestions = async (engine: Engine): Promise<ObservabilityAnswers> => {
  const incidents = await incidentReport(engine);

  const asAnswer = (record: {
    consumer: string;
    lastError?: string;
    attemptCount: number;
    state: string;
    correlationId?: string;
  }): FailureAnswer => ({
    what: record.lastError ?? 'no error recorded',
    consumer: record.consumer,
    correlationId: record.correlationId ?? 'unknown',
    attempts: record.attemptCount,
    // Retried is `attempts > 1`, not "the state says retrying" — a job that failed three times and
    // then succeeded has been retried, and an operator asking "was it retried" wants that.
    retried: record.attemptCount > 1,
    state: record.state,
    needsAPerson: record.state === 'dead_letter',
  });

  const failures = [
    // A dead letter carries its **whole failure history** rather than one error, which is the more
    // informative shape: the attempt that failed *differently* is usually the one that explains it.
    // So the answer names the latest and says how many there were.
    ...incidents.deadLetters.map((record) =>
      asAnswer({
        consumer: record.source,
        ...(record.failureHistory.at(-1)?.error === undefined
          ? {}
          : {
              lastError: `${record.failureHistory.at(-1)?.error} (${record.failureHistory.length} attempt(s) recorded)`,
            }),
        attemptCount: record.failureHistory.length,
        state: 'dead_letter',
        correlationId: record.correlationId,
      }),
    ),
    // A struggling event is about the *event* rather than a consumer, so `consumer` reads as the
    // event name here. Not a fudge: an operator asking "which engine" about a retrying event wants
    // the event's own name, because the event is what is failing to be handled.
    ...incidents.struggling.map((record) =>
      asAnswer({
        consumer: record.eventName,
        ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
        attemptCount: record.attemptCount,
        state: record.state,
      }),
    ),
  ];

  // Degraded, from two independent sources that must both be consulted: what the checks found, and
  // what a person declared. Either alone would leave an operator with half the picture — a paused
  // agent is not unhealthy, and an unhealthy provider is not paused.
  const degraded: ObservabilityAnswers['degraded'] = [
    ...incidents.health.dependencies
      .filter((dependency) => dependency.state !== 'healthy')
      .map((dependency) => ({
        name: dependency.name,
        kind: 'provider' as const,
        detail: dependency.detail ?? dependency.state,
      })),
    ...(await activeControls(engine)).map((control) => ({
      name: control.target,
      kind:
        control.kind === 'pause_agent'
          ? ('agent' as const)
          : control.kind === 'suspend_integration'
            ? ('integration' as const)
            : ('provider' as const),
      detail: `${control.kind} by ${control.createdBy}: ${control.reason}`,
    })),
  ];

  // Approvals whose effect did not follow, counted from the plan steps. The provenance read gives
  // the detail; an operator scanning a page needs the number.
  const refusedSteps = (await engine.store.actionPlanSteps.query([eq('dispatched', false)])).length;

  const humanActionRequired: string[] = [];
  if (incidents.deadLetters.length > 0) {
    humanActionRequired.push(
      `${incidents.deadLetters.length} dead-lettered job(s) will not retry on their own.`,
    );
  }
  if (incidents.staleWorkers.length > 0) {
    humanActionRequired.push(
      `${incidents.staleWorkers.length} worker(s) stopped heartbeating. Their leases return to the queue, and nothing drains until one comes back.`,
    );
  }
  if (incidents.workers.length === 0) {
    // Stated as its own fact. "No worker registered" and "every worker healthy" look identical on a
    // page that only lists problems, and they are opposite situations.
    humanActionRequired.push('No worker is registered at all. Nothing is draining.');
  }
  if (incidents.health.state === 'unhealthy') {
    humanActionRequired.push('A dependency is unavailable. Fail-closed paths are refusing.');
  }

  return {
    failures,
    stuck: failures.filter((failure) => failure.needsAPerson),
    degraded,
    refusedEffects: refusedSteps,
    humanActionRequired,
    generatedAt: engine.clock.now(),
  };
};

/**
 * Which question each field answers.
 *
 * A map rather than a comment, so the Phase 97 test can assert every question is answered by
 * something and no question is answered by nothing. A question list with no binding is a wish.
 */
export const ANSWERED_BY: Readonly<Record<OperatorQuestion, string>> = {
  what_failed: 'failures[].what',
  which_engine: 'failures[].consumer',
  which_correlation: 'failures[].correlationId',
  was_it_retried: 'failures[].retried and failures[].attempts',
  effect_applied_or_refused: 'refusedEffects, and provenanceFor() for the detail',
  stuck_or_dead_lettered: 'stuck[]',
  degraded_provider_or_agent: 'degraded[]',
  human_action_required: 'humanActionRequired[]',
  may_this_instance_serve_traffic: 'readiness()',
};

export interface Readiness {
  /** Whether this instance may serve traffic. */
  readonly ready: boolean;
  /** Each check, so a failing readiness probe says which one. */
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

/**
 * Facts about the deployment that the engine cannot see for itself — RC3.
 *
 * The engine holds ports. Whether the store behind them is a database or a `Map`, and whether this
 * process calls itself a deployment, are composition-root facts, and a readiness surface that
 * *guessed* at them would be reporting its own assumptions. So the caller supplies them and this
 * function decides what they mean.
 *
 * Omitting them is allowed and treated as "not a deployment": the checks that depend on them are
 * reported as satisfied, because a unit test and `npm run dev` are legitimately neither persistent
 * nor hosted, and a readiness probe that failed there would be noise rather than information.
 */
export interface DeploymentFacts {
  /** Whether a database is configured, so state survives a restart and instances agree. */
  readonly persistentStore?: boolean;
  /** Whether this process is running as a hosted deployment rather than locally. */
  readonly hosted?: boolean;
}

/**
 * Whether this instance may serve traffic — Phase 97's one genuine gap, extended by RC3.
 *
 * Every check here is a thing that makes an instance **unfit while leaving it healthy**, which is
 * the whole reason this is not `/api/health`:
 *
 *   1. **The store answers.** Without it every command refuses, which is correct and is not
 *      something to route traffic at.
 *   2. **A worker is registered.** An instance serving reads whose projections nothing advances
 *      will look fine and go quietly stale.
 *   3. **No forced degraded mode.** An operator who declared degraded mode has said something the
 *      checks cannot see, and a balancer should respect it.
 *   4. **State is persistent** (hosted only). An in-memory instance passes every check above and
 *      loses everything on restart. Nothing it could be *asked* reveals that.
 *   5. **Sign-in is possible.** A deployment where `identity.authenticate` refuses every caller is
 *      running, healthy, and cannot be used by anybody who is not already holding a session — the
 *      exact state RC2 shipped, which no probe reported because no probe asked.
 *   6. **Object storage is durable** (hosted only). Same shape as 4: the in-process fake answers
 *      `put`, `exists` and `remove` successfully, so only the provider's own claim distinguishes it.
 *   7. **Providers are named.** Reported rather than required: a fallback model provider is a
 *      degraded product and not an unfit instance, so this check informs and does not gate.
 *
 * **No secret ever appears in a check's detail.** Providers are named, the store is described as
 * configured or not, and no connection string, key or bucket name is reported — a readiness endpoint
 * is usually the most reachable thing a deployment has.
 *
 * Migration drift is deliberately **not** checked here. It is a deployment-time gate — the migration
 * runner already refuses to start against a drifted schema — and re-checking it per request would
 * mean a readiness probe doing schema introspection on every poll.
 */
export const readiness = async (engine: Engine, deployment: DeploymentFacts = {}): Promise<Readiness> => {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  let storeOk = false;
  try {
    await engine.store.actors.count();
    storeOk = true;
  } catch {
    storeOk = false;
  }
  checks.push({
    name: 'store',
    ok: storeOk,
    detail: storeOk ? 'the store answers' : 'the store did not answer; every command would refuse',
  });

  const workers = await engine.workers.list();
  const live = workers.length > 0;
  checks.push({
    name: 'worker',
    ok: live,
    detail: live
      ? `${workers.length} worker(s) registered`
      : 'no worker is registered, so projections would not advance',
  });

  const controls = await activeControls(engine);
  const forced = controls.some((control) => control.kind === 'force_degraded_mode');
  checks.push({
    name: 'not_forced_degraded',
    ok: !forced,
    detail: forced
      ? 'an operator has declared degraded mode'
      : 'no operator has declared degraded mode',
  });

  // ── RC3: the deployment checks ────────────────────────────────────────────
  const hosted = deployment.hosted ?? false;

  const persistent = deployment.persistentStore ?? false;
  checks.push({
    name: 'persistent_store',
    // Only a *hosted* instance is unfit for being in memory. `npm run dev` is legitimately
    // in-memory, and a probe that failed there would be noise.
    ok: persistent || !hosted,
    detail: persistent
      ? 'a database is configured, so state survives a restart and instances agree'
      : 'in-memory adapters: state is lost on restart and is not shared between processes',
  });

  /**
   * Can anybody sign in at all?
   *
   * Two ways this fails and they are different. `allowPasswordlessSignIn` true means the credential
   * check is **skipped** — correct for local development and a hole in a deployment. False with an
   * unreachable credential table means the check runs and can never pass, which is the state RC2
   * shipped: running, healthy, and unusable by anybody not already holding a session.
   */
  const credentialsRequired = !engine.config.allowPasswordlessSignIn;
  let credentialStoreOk = false;
  try {
    await engine.store.actorCredentials.count();
    credentialStoreOk = true;
  } catch {
    credentialStoreOk = false;
  }
  const signInOk = credentialsRequired ? credentialStoreOk : !hosted;
  checks.push({
    name: 'sign_in',
    ok: signInOk,
    detail: !credentialsRequired
      ? 'the credential check is disabled, which is a development setting and must not be deployed'
      : credentialStoreOk
        ? 'a credential is required and the credential store answers'
        : 'a credential is required and the credential store did not answer, so nobody could sign in',
  });

  const objectStore = engine.providers.objectStore;
  checks.push({
    name: 'object_storage',
    ok: objectStore.durable || !hosted,
    detail: objectStore.durable
      ? `durable object storage (${objectStore.name})`
      : `object storage is ${objectStore.name}: bytes do not outlive the process`,
  });

  /**
   * The providers, **reported rather than required.**
   *
   * A deterministic fallback model provider is a degraded product, not an unfit instance: agents
   * escalate to a person instead of proposing, which is the behaviour the fallback exists to
   * produce. Gating readiness on it would take a whole deployment out of rotation over a feature
   * that already degrades correctly — so this check states what is configured and always passes.
   */
  const { transcription, pii, assistance } = engine.providers;
  checks.push({
    name: 'providers',
    ok: true,
    detail:
      `transcription=${transcription.name}, pii=${pii.name}, `
      + `assistance=${assistance.name} (${assistance.live ? 'live' : 'deterministic fallback'})`,
  });

  return { ready: checks.every((check) => check.ok), checks };
};

/**
 * The absences, as code.
 *
 * `observabilityHasItsOwnLog` — false. Every answer above comes from a record something else already
 * writes for its own reasons, which is what makes the answers trustworthy: they cannot be stale
 * relative to the system, because they *are* the system's rows.
 *
 * `readinessIsHealth` — false. The two endpoints answer different questions for different callers,
 * and conflating them sends traffic to an instance whose schema is behind.
 */
export const observabilityHasItsOwnLog = (): false => false;
export const readinessIsHealth = (): false => false;
