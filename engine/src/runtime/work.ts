/**
 * The async state vocabulary every async-backed record shares.
 * A record is never implicitly "done" — it is in exactly one of these states.
 */
export type WorkState = 'queued' | 'processing' | 'ready' | 'failed' | 'dead_letter';

export const WORK_STATES: readonly WorkState[] = ['queued', 'processing', 'ready', 'failed', 'dead_letter'];

const LEGAL: Readonly<Record<WorkState, readonly WorkState[]>> = {
  queued: ['processing'],
  processing: ['ready', 'failed'],
  failed: ['queued', 'dead_letter'],
  ready: [],
  dead_letter: [],
};

export const canTransitionWork = (from: WorkState, to: WorkState): boolean =>
  (LEGAL[from] ?? []).includes(to);

export const isTerminalWork = (state: WorkState): boolean => state === 'ready' || state === 'dead_letter';
