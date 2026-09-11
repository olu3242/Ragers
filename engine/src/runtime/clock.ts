/** Time is injected so every temporal rule (expiry, decay, windows) is testable. */
export interface Clock {
  now(): number;
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

export interface FixedClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export const fixedClock = (startMs = 1_700_000_000_000): FixedClock => {
  let current = startMs;
  return {
    now: () => current,
    isoNow: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
};
