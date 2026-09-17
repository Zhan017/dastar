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

/** Writes a JSON report under apps/harness/results (ignored by git) and returns its path. */
export async function writeReport(name: string, data: unknown): Promise<string> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(data, null, 2));
  return path;
}
