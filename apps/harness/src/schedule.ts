import type { Rng } from "./rng.js";

export type Step = { ratePerSec: number; seconds: number };
export type Arrival = { seq: number; step: number; atMs: number };

/**
 * Poisson arrivals for every step, generated before the run starts. Offered load is therefore fixed by the
 * plan and does not slow down when the system under test does.
 */
export function planArrivals(steps: readonly Step[], r: Rng): Arrival[] {
  const out: Arrival[] = [];
  let stepStart = 0;
  let seq = 0;
  steps.forEach((s, step) => {
    const end = stepStart + s.seconds * 1000;
    if (s.ratePerSec > 0) {
      for (let t = stepStart + r.expMs(s.ratePerSec); t < end; t += r.expMs(s.ratePerSec)) out.push({ seq: seq++, step, atMs: t });
    }
    stepStart = end;
  });
  return out;
}

export type OpenLoopClock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: OpenLoopClock = { now: () => performance.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) };

/**
 * Starts `fire` for each arrival at its planned time and never waits for an earlier one to finish.
 * `lateMs` is how far behind the plan the dispatcher was; callers measure latency from the planned time,
 * so a slow dispatcher or a slow system cannot hide queueing. Returns the number of arrivals started.
 */
export async function runOpenLoop(
  arrivals: readonly Arrival[],
  fire: (a: Arrival, lateMs: number) => void,
  opts: { clock?: OpenLoopClock; stopped?: () => boolean; epoch?: number } = {},
): Promise<{ started: number; startedAt: number }> {
  const clock = opts.clock ?? realClock;
  // a caller that runs several loops, or keeps its own timeline, pins them all to one epoch
  const startedAt = opts.epoch ?? clock.now();
  let started = 0;
  for (const a of arrivals) {
    if (opts.stopped?.()) break;
    const wait = startedAt + a.atMs - clock.now();
    if (wait > 1) await clock.sleep(wait);
    if (opts.stopped?.()) break;
    fire(a, Math.max(0, clock.now() - (startedAt + a.atMs)));
    started += 1;
  }
  return { started, startedAt };
}
