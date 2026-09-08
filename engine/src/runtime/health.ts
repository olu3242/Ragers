import type { Clock } from './clock.ts';

export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  readonly name: string;
  readonly state: HealthState;
  readonly detail?: string;
  readonly checkedAt: string;
}

export interface HealthReport {
  readonly state: HealthState;
  readonly dependencies: readonly DependencyHealth[];
  readonly checkedAt: string;
}

export interface HealthCheck {
  readonly name: string;
  check(): Promise<{ state: HealthState; detail?: string }>;
}

export interface HealthRegistry {
  register(check: HealthCheck): void;
  report(): Promise<HealthReport>;
}

const worst = (states: readonly HealthState[]): HealthState => {
  if (states.includes('unhealthy')) return 'unhealthy';
  if (states.includes('degraded')) return 'degraded';
  return 'healthy';
};

export const createHealthRegistry = (clock: Clock): HealthRegistry => {
  const checks: HealthCheck[] = [];
  return {
    register: (check) => {
      checks.push(check);
    },
    report: async () => {
      const at = clock.isoNow();
      const dependencies: DependencyHealth[] = [];
      for (const check of checks) {
        try {
          const result = await check.check();
          dependencies.push({
            name: check.name,
            state: result.state,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
            checkedAt: at,
          });
        } catch (cause) {
          dependencies.push({
            name: check.name,
            state: 'unhealthy',
            detail: cause instanceof Error ? cause.message : 'check threw',
            checkedAt: at,
          });
        }
      }
      return {
        state: worst(dependencies.map((d) => d.state)),
        dependencies,
        checkedAt: at,
      };
    },
  };
};
