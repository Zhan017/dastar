/** mulberry32: a small seeded generator, so a run's arrivals and choices can be repeated from its seed. */
export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  /** Exponential inter-arrival time in milliseconds for a rate per second. */
  expMs(ratePerSec: number): number;
};

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    pick: <T>(xs: readonly T[]): T => {
      if (xs.length === 0) throw new Error("pick from an empty list");
      return xs[int(xs.length)]!;
    },
    expMs: (ratePerSec: number): number => (-Math.log(1 - next()) / ratePerSec) * 1000,
  };
}
