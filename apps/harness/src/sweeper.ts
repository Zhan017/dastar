import type { Dastar } from "@dastar/db";

export type SweepConfig = {
  everyMs: number;
  /** Rows per batch. */
  limit: number;
  /** Keep taking batches within one tick while a batch comes back full. */
  drain: boolean;
};

/** The sweeper the system design describes (section 10.4): every 5 s, batches of 20, repeated while due rows remain. */
export const DESIGN_SWEEP: SweepConfig = { everyMs: 5_000, limit: 20, drain: true };

export type SweepStats = {
  config: SweepConfig; ticks: number; batches: number;
  /** Rows expired by this sweeper across the whole database; a run that shares a database with earlier runs sees their dead holds here too. */
  expired: number;
  errors: number; maxBatchesInTick: number;
};
export type Sweeper = { stats: SweepStats; stop: () => Promise<void> };

/**
 * Runs the sweeper on the worker handle. Every measurement command uses this one loop and reports its
 * configuration, so a result always says which sweeper it was measured with. `paused` skips ticks without
 * stopping the loop. `onExpired` fires after each batch with the ids it expired, for a caller that needs to
 * know which rows were this sweeper's doing rather than only how many.
 */
export function startSweeper(worker: Pick<Dastar, "expireDue">, config: SweepConfig, paused: () => boolean = () => false, onExpired?: (ids: readonly string[]) => void): Sweeper {
  const stats: SweepStats = { config, ticks: 0, batches: 0, expired: 0, errors: 0, maxBatchesInTick: 0 };
  let stopped = false;
  let wake: (() => void) | null = null;
  const loop = (async (): Promise<void> => {
    while (!stopped) {
      if (!paused()) {
        stats.ticks += 1;
        let batches = 0;
        try {
          for (;;) {
            const batch = await worker.expireDue({ limit: config.limit });
            batches += 1;
            stats.batches += 1;
            stats.expired += batch.expired.length;
            onExpired?.(batch.expired);
            if (!config.drain || batch.expired.length < config.limit || stopped || paused()) break;
          }
        } catch {
          stats.errors += 1;
        }
        stats.maxBatchesInTick = Math.max(stats.maxBatchesInTick, batches);
      }
      // a stop that arrived during the tick must not wait out the interval
      if (stopped) break;
      await new Promise<void>((res) => {
        const t = setTimeout(res, config.everyMs);
        wake = () => { clearTimeout(t); res(); };
      });
    }
  })();
  return { stats, stop: async () => { stopped = true; wake?.(); await loop; } };
}
