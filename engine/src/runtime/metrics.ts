/** Minimal metrics sink: counters and duration observations, tagged. */
export type MetricTags = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, tags?: MetricTags, by?: number): void;
  observe(name: string, valueMs: number, tags?: MetricTags): void;
  snapshot(): MetricsSnapshot;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly observations: Readonly<Record<string, readonly number[]>>;
}

const keyOf = (name: string, tags?: MetricTags): string => {
  if (!tags || Object.keys(tags).length === 0) return name;
  const parts = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return `${name}{${parts.join(',')}}`;
};

export const createMetrics = (): Metrics => {
  const counters = new Map<string, number>();
  const observations = new Map<string, number[]>();
  return {
    increment: (name, tags, by = 1) => {
      const k = keyOf(name, tags);
      counters.set(k, (counters.get(k) ?? 0) + by);
    },
    observe: (name, valueMs, tags) => {
      const k = keyOf(name, tags);
      const list = observations.get(k) ?? [];
      list.push(valueMs);
      observations.set(k, list);
    },
    snapshot: () => ({
      counters: Object.fromEntries(counters),
      observations: Object.fromEntries(observations),
    }),
  };
};
