import type { ClientBase } from "pg";
import type { Dastar, HoldInput, HoldOutcome } from "@dastar/db";
import type { BenchSeed } from "./seed.js";
import { percentiles, type Percentiles } from "./stats.js";

export type RaceResult = {
  n: number; winners: number; conflicts: number; other: Record<string, number>;
  overlaps: number; retries: number; latencyMs: Percentiles; elapsedMs: number;
};

/** Pairs of active unit rows on the same unit with overlapping ranges. Zero is the invariant. */
export async function overlapPairs(owner: ClientBase): Promise<number> {
  const r = await owner.query(
    `select count(*)::int as pairs
       from dastar.reservation_unit a
       join dastar.reservation_unit b on a.unit_id = b.unit_id and a.reservation_id < b.reservation_id and a.during && b.during
      where a.active and b.active`,
  );
  return r.rows[0].pairs as number;
}

/**
 * N holds for one unit and one slot, distinct actors and keys, released together by a start gate.
 * A correctness run: no timeouts are expected, and a thrown error counts under `other` as "thrown:<code>".
 */
export async function runRace(d: Dastar, owner: ClientBase, seed: BenchSeed, n: number): Promise<RaceResult> {
  const startsAt = new Date(Date.UTC(2045, 0, 1, 19)).toISOString();
  const unit = seed.units[0]!;
  let retries = 0;
  const latencies: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const runners = Array.from({ length: n }, (_, k) => (async (): Promise<HoldOutcome> => {
    const input: HoldInput = {
      venueId: seed.venue, actor: `race:${k}`, traceId: `race-${k}`, idempotencyKey: `race-${k}`,
      partySize: 2, startsAt, durationMinutes: 90, assignment: { kind: "unit", id: unit },
    };
    await gate;
    const t0 = performance.now();
    try {
      return await d.hold(input, { onRetry: () => { retries += 1; } });
    } finally {
      latencies.push(performance.now() - t0);
    }
  })());
  const t0 = performance.now();
  release();
  const settled = await Promise.allSettled(runners);
  const elapsedMs = performance.now() - t0;
  const other: Record<string, number> = {};
  let winners = 0;
  let conflicts = 0;
  for (const s of settled) {
    if (s.status === "rejected") {
      const code = (s.reason as { code?: string }).code ?? "unknown";
      other[`thrown:${code}`] = (other[`thrown:${code}`] ?? 0) + 1;
    } else if (s.value.ok) {
      winners += 1;
    } else if (s.value.error.code === "hold_conflict") {
      conflicts += 1;
    } else {
      other[s.value.error.code] = (other[s.value.error.code] ?? 0) + 1;
    }
  }
  return { n, winners, conflicts, other, overlaps: await overlapPairs(owner), retries, latencyMs: percentiles(latencies), elapsedMs };
}
