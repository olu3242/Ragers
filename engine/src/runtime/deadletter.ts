/**
 * Dead-letter store. Exhausted work is never dropped: it lands here with its
 * full failure history so an operator can diagnose and replay it.
 */
export interface DeadLetterFailure {
  readonly attempt: number;
  readonly error: string;
  readonly at: number;
}

export interface DeadLetterRecord {
  readonly id: string;
  readonly source: string;
  readonly eventName: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly failureHistory: readonly DeadLetterFailure[];
  readonly createdAt: number;
  readonly replayCount: number;
}

export interface DeadLetterStore {
  record(entry: Omit<DeadLetterRecord, 'id' | 'createdAt' | 'replayCount'>): Promise<DeadLetterRecord>;
  list(): Promise<readonly DeadLetterRecord[]>;
  get(id: string): Promise<DeadLetterRecord | undefined>;
  markReplayed(id: string): Promise<void>;
  appendFailure(id: string, failure: DeadLetterFailure): Promise<void>;
}
