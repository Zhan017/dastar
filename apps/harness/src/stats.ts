import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Percentiles = { count: number; p50: number; p95: number; p99: number; max: number };

export function percentiles(xs: number[]): Percentiles {
  if (xs.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  return { count: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1]! };
}

/** One measured duration. `censored` marks a lower bound: the request ended before the phase did, so the true value is at least `ms`. */
export type Sample = { ms: number; censored: boolean };

/**
 * A percentile of a sample that may hold lower bounds. `atLeast` counts every censored sample at what was
 * observed, so the true percentile cannot be smaller. `atMost` assumes every censored sample never
 * finished; it is null when that leaves the percentile unbounded. Without censoring the two are equal.
 * A limit is broken when `atLeast` exceeds it and kept only when `atMost` stays within it.
 */
export type Quantile = { atLeast: number; atMost: number | null };

/**
 * A distribution for reports and verdicts. A percentile is given only when the share of the sample above it
 * is worth at least three samples (6 samples for p50, 60 for p95, 300 for p99); otherwise it is null. An empty distribution is
 * all nulls, never zeros, so a missing measurement cannot pass a limit.
 */
export type Dist = { count: number; censored: number; p50: Quantile | null; p95: Quantile | null; p99: Quantile | null; max: Quantile | null };

export const exact = (xs: readonly number[]): Sample[] => xs.map((ms) => ({ ms, censored: false }));

export function dist(samples: readonly Sample[]): Dist {
  const n = samples.length;
  const lower = samples.map((x) => x.ms).sort((a, b) => a - b);
  // the same sample with every censored value pushed to infinity: what the percentile could be at worst
  const upper = samples.map((x) => (x.censored ? Number.POSITIVE_INFINITY : x.ms)).sort((a, b) => a - b);
  const at = (p: number): Quantile | null => {
    if (n * (1 - p / 100) < 3) return null;
    const k = Math.min(n - 1, Math.floor((p / 100) * n));
    return { atLeast: lower[k]!, atMost: Number.isFinite(upper[k]!) ? upper[k]! : null };
  };
  const censored = samples.filter((x) => x.censored).length;
  return { count: n, censored, p50: at(50), p95: at(95), p99: at(99), max: n === 0 ? null : { atLeast: lower[n - 1]!, atMost: censored === 0 ? lower[n - 1]! : null } };
}

/** "n/a" for too few samples, "12.3" for an exact value, "12.3..45.6" for bounds, ">=12.3" when censoring leaves it unbounded. */
export function fmt(q: Quantile | number | null, digits = 1): string {
  if (q === null) return "n/a";
  if (typeof q === "number") return q.toFixed(digits);
  if (q.atMost === null) return `>=${q.atLeast.toFixed(digits)}`;
  return q.atMost === q.atLeast ? q.atLeast.toFixed(digits) : `${q.atLeast.toFixed(digits)}..${q.atMost.toFixed(digits)}`;
}

/** Writes a JSON report under apps/harness/results (ignored by git) and returns its path. */
export async function writeReport(name: string, data: unknown): Promise<string> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(data, null, 2));
  return path;
}
