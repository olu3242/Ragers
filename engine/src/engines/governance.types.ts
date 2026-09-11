export type { AuditEvent } from '../ports/store.ts';

/** Dead-letter summary for the admin console. Payloads stay out of the list view. */
export interface DeadLetterRecordView {
  readonly id: string;
  readonly source: string;
  readonly eventName: string;
  readonly attempts: number;
  readonly replayCount: number;
  readonly createdAt: number;
}
