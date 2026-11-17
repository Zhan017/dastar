import type { Dastar, RetentionBatch } from "@dastar/db";

export type RetentionConfig = {
  everyMs: number;
  /** Rows per batch, from each table. */
  limit: number;
  /** Keep taking batches within one tick while any table's batch comes back full. */
  drain: boolean;
};

/** The retention job the system design describes: every minute, batches of 500 per table, repeated while a batch comes back full. */
export const DESIGN_RETENTION: RetentionConfig = { everyMs: 60_000, limit: 500, drain: true };

export type RetentionStats = {
  config: RetentionConfig; ticks: number; batches: number;
  /** Idempotency rows deleted by this loop; outbox rows, external sessions, and their calls and turns likewise. */
  idempotency: number; outbox: number; sessions: number; calls: number; turns: number;
  errors: number; maxBatchesInTick: number;
};
export type Retention = { stats: RetentionStats; stop: () => Promise<void> };

export type RetentionHooks = {
  /** Skips ticks without stopping the loop. */
  paused?: () => boolean;
  /** Fires after each batch with the number of rows it deleted from each table. */
  onPurged?: (counts: RetentionBatch) => void;
  /** Fires with the error of a failed batch; the loop counts it and carries on at the next tick. */
  onError?: (error: unknown) => void;
};

/** Runs the retention job on the worker handle, the loop `startSweeper` is for expiry. */
export function startRetention(worker: Pick<Dastar, "purgeRetained">, config: RetentionConfig, hooks: RetentionHooks = {}): Retention {
  const paused = hooks.paused ?? (() => false);
  const stats: RetentionStats = { config, ticks: 0, batches: 0, idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0, errors: 0, maxBatchesInTick: 0 };
  let stopped = false;
  let wake: (() => void) | null = null;
  const loop = (async (): Promise<void> => {
    while (!stopped) {
      if (!paused()) {
        stats.ticks += 1;
        let batches = 0;
        try {
          for (;;) {
            const batch = await worker.purgeRetained({ limit: config.limit });
            batches += 1;
            stats.batches += 1;
            stats.idempotency += batch.idempotency;
            stats.outbox += batch.outbox;
            stats.sessions += batch.sessions;
            stats.calls += batch.calls;
            stats.turns += batch.turns;
            hooks.onPurged?.(batch);
            const full = batch.idempotency >= config.limit || batch.outbox >= config.limit || batch.sessions >= config.limit
              || batch.calls >= config.limit || batch.turns >= config.limit;
            if (!config.drain || !full || stopped || paused()) break;
          }
        } catch (e) {
          stats.errors += 1;
          hooks.onError?.(e);
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
