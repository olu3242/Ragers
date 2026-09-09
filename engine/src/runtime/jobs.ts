/**
 * Phase 21 — distributed orchestration primitives.
 *
 * Delivery is a durable *job*, not an in-process callback. A job is leased to
 * exactly one worker for a bounded time; if that worker dies mid-flight the
 * lease expires and another worker picks the job up, which is what makes
 * restart recovery a property of the system rather than of a process staying
 * alive.
 */
export type JobState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'waiting'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'dead_letter';

export const JOB_STATES: readonly JobState[] = [
  'queued',
  'leased',
  'running',
  'waiting',
  'retrying',
  'completed',
  'failed',
  'dead_letter',
];

const LEGAL: Readonly<Record<JobState, readonly JobState[]>> = {
  // A lease can expire back to queued without the worker doing anything.
  queued: ['leased'],
  leased: ['running', 'queued'],
  running: ['completed', 'failed', 'waiting'],
  // `waiting` is a job parked on an external condition; it re-enters the queue.
  waiting: ['queued', 'failed'],
  failed: ['retrying', 'dead_letter'],
  retrying: ['queued'],
  completed: [],
  dead_letter: [],
};

export const canTransitionJob = (from: JobState, to: JobState): boolean => (LEGAL[from] ?? []).includes(to);

export const isTerminalJob = (state: JobState): boolean => state === 'completed' || state === 'dead_letter';

/** States in which a job is held by a worker and must not be claimed by another. */
export const isHeldJob = (state: JobState): boolean => state === 'leased' || state === 'running';

export type WorkerState = 'alive' | 'draining' | 'dead';

export interface WorkerRecord {
  readonly id: string;
  readonly hostname: string;
  readonly startedAt: number;
  readonly lastHeartbeatAt: number;
  readonly state: WorkerState;
}

/**
 * Worker registry. A worker that stops heartbeating is declared dead, which is
 * the signal to reclaim its leases.
 */
export interface WorkerRegistry {
  register(worker: { id: string; hostname: string; now: number }): Promise<void>;
  heartbeat(workerId: string, now: number): Promise<void>;
  /** Mark workers whose heartbeat is older than the timeout as dead. */
  reapStale(olderThan: number): Promise<readonly string[]>;
  drain(workerId: string): Promise<void>;
  get(workerId: string): Promise<WorkerRecord | undefined>;
  list(): Promise<readonly WorkerRecord[]>;
}

export interface JobHistoryEntry {
  readonly deliveryId: string;
  readonly attempt: number;
  readonly state: JobState;
  readonly workerId?: string;
  readonly detail?: string;
  readonly at: number;
}

/** Append-only execution history, so an operator can reconstruct what happened. */
export interface JobHistory {
  append(entry: JobHistoryEntry): Promise<void>;
  forDelivery(deliveryId: string): Promise<readonly JobHistoryEntry[]>;
}

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;
/** A worker is presumed dead after missing this many heartbeats. */
export const HEARTBEAT_GRACE_MULTIPLIER = 3;

export const heartbeatDeadline = (heartbeatMs = DEFAULT_HEARTBEAT_MS): number =>
  heartbeatMs * HEARTBEAT_GRACE_MULTIPLIER;
