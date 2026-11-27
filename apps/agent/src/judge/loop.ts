import type { Usage } from "../provider.js";
import { judgeOne, type JudgeDeps } from "./turn.js";

/** What one read of the due turns came to: how many were read and what became of each one that was taken up. */
export type BatchOutcome = {
  size: number; judged: number; failed: number; discarded: number;
  /** Turns left with no result for a later pass after a failure that may pass. */
  retried: number;
  /** The day's calls ran out; the turns after the one that found it were not taken up. */
  capped: boolean;
  /** The line of the error that ended the batch: the provider refused the key. */
  fatal?: string;
  /** The tokens of the calls whose answer was stored. */
  usage: Usage;
};

const noUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addUsage(into: Usage, usage: Usage | null): void {
  if (usage === null) return;
  into.input += usage.input;
  into.output += usage.output;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
}

/**
 * Reads up to `limit` due turns and judges them one at a time. It stops at the first turn that finds the day's calls used
 * up or a provider that refuses the key, and between turns once `stopped` says so.
 */
export async function judgeBatch(deps: JudgeDeps, limit: number, stopped: () => boolean = () => false): Promise<BatchOutcome> {
  const due = await deps.dastar.judge.dueTurns({ limit });
  const outcome: BatchOutcome = { size: due.length, judged: 0, failed: 0, discarded: 0, retried: 0, capped: false, usage: noUsage() };
  for (const turn of due) {
    if (stopped()) break;
    const verdict = await judgeOne(deps, turn);
    switch (verdict.kind) {
      case "judged":
        outcome.judged += 1;
        addUsage(outcome.usage, verdict.usage);
        break;
      case "failed":
        outcome.failed += 1;
        addUsage(outcome.usage, verdict.usage);
        break;
      case "discarded":
        outcome.discarded += 1;
        break;
      case "retry":
        outcome.retried += 1;
        break;
      case "capped":
        outcome.capped = true;
        return outcome;
      case "fatal":
        outcome.fatal = verdict.line;
        return outcome;
    }
  }
  return outcome;
}

/**
 * Judges what is due and returns the totals of every batch. It takes batches until none is due, the day's calls run
 * out, or the provider refuses the key; a turn left for a later pass comes back in the next batch, until its third
 * failure stores it.
 */
export async function judgeOnce(deps: JudgeDeps, limit: number): Promise<BatchOutcome> {
  const total: BatchOutcome = { size: 0, judged: 0, failed: 0, discarded: 0, retried: 0, capped: false, usage: noUsage() };
  for (;;) {
    const batch = await judgeBatch(deps, limit);
    total.size += batch.size;
    total.judged += batch.judged;
    total.failed += batch.failed;
    total.discarded += batch.discarded;
    total.retried += batch.retried;
    addUsage(total.usage, batch.usage);
    if (batch.capped) total.capped = true;
    if (batch.fatal !== undefined) total.fatal = batch.fatal;
    if (batch.size === 0 || batch.capped || batch.fatal !== undefined) return total;
  }
}

export type JudgeLoopConfig = {
  everyMs: number;
  /** The most turns one batch judges. */
  limit: number;
  /** Keep taking batches within one tick while each comes back full and none of its turns is left for a later pass. */
  drain: boolean;
};

export type JudgeStats = {
  config: JudgeLoopConfig; ticks: number; batches: number;
  judged: number; failed: number; discarded: number; retried: number;
  /** Batches that failed on the database; the loop carries on at the next tick. */
  errors: number;
  /** Batches that found the day's calls used up. */
  capped: number;
  /** The line of the error that ended the loop. */
  fatal?: string;
  usage: Usage;
};

export type RunningJudge = {
  stats: JudgeStats;
  /** Ends the loop after the turn in flight and resolves once it has ended. */
  stop(): Promise<void>;
  /** Resolves when the loop has ended: stopped, or ended by a fatal error. */
  finished: Promise<void>;
};

export type JudgeHooks = {
  /** Fires after each batch, including one that found nothing due. */
  onBatch?: (batch: BatchOutcome) => void;
  /** Fires with the error of a failed batch; the loop counts it and carries on at the next tick. */
  onError?: (error: unknown) => void;
};

/** Runs the judge on its ticks, the loop `startRetention` is for the retention job. */
export function startJudge(deps: JudgeDeps, config: JudgeLoopConfig, hooks: JudgeHooks = {}): RunningJudge {
  const stats: JudgeStats = {
    config, ticks: 0, batches: 0, judged: 0, failed: 0, discarded: 0, retried: 0, errors: 0, capped: 0, usage: noUsage(),
  };
  let stopped = false;
  let wake: (() => void) | null = null;
  const loop = (async (): Promise<void> => {
    while (!stopped) {
      stats.ticks += 1;
      try {
        for (;;) {
          const batch = await judgeBatch(deps, config.limit, () => stopped);
          stats.batches += 1;
          stats.judged += batch.judged;
          stats.failed += batch.failed;
          stats.discarded += batch.discarded;
          stats.retried += batch.retried;
          if (batch.capped) stats.capped += 1;
          addUsage(stats.usage, batch.usage);
          hooks.onBatch?.(batch);
          if (batch.fatal !== undefined) {
            stats.fatal = batch.fatal;
            return;
          }
          // a batch with a turn left for later waits for the next tick; so does one that found the day's calls used up
          const more = batch.size === config.limit && batch.retried === 0 && !batch.capped;
          if (!config.drain || !more || stopped) break;
        }
      } catch (e) {
        stats.errors += 1;
        hooks.onError?.(e);
      }
      // a stop that arrived during the tick must not wait out the interval
      if (stopped) break;
      await new Promise<void>((res) => {
        const t = setTimeout(res, config.everyMs);
        wake = () => { clearTimeout(t); res(); };
      });
    }
  })();
  return { stats, stop: async () => { stopped = true; wake?.(); await loop; }, finished: loop };
}
