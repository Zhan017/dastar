import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { runMigrateUnderLoad, judgeUnderLoad, overlapping, startedWithin, windowStats, type MigrationWindow } from "../src/migrate-under-load.js";
import type { HoldRecord } from "../src/load.js";
import { dropNaiveDatabase, withDatabase } from "../src/naive.js";

const MIGRATIONS = new URL("../../../packages/db/migrations", import.meta.url).pathname;

const rec = (over: Partial<HoldRecord>): HoldRecord => ({
  seq: 0, step: 0, mix: "overlapping", cls: "ok", code: "ok", atMs: 0, startedMs: 0, doneMs: 10, e2eMs: 10, e2eCensored: false, stored: null,
  poolWaitMs: 1, poolWaitCensored: false, unitLockMs: 2, unitLockCensored: false, transactionMs: 8, connectionHeldMs: 9, retries: 0, ...over,
});

describe("migration windows", () => {
  it("a request that arrived before the migration and failed during it belongs to that migration", () => {
    const rs = [
      rec({ seq: 1, atMs: 900, startedMs: 900, doneMs: 990 }),                                                   // answered before it began
      rec({ seq: 2, atMs: 950, startedMs: 950, doneMs: 4_100, cls: "timeout", code: "timeout", e2eMs: 3_150 }),   // arrived before, blocked by it, failed
      rec({ seq: 3, atMs: 1_500, startedMs: 1_500, doneMs: 3_050 }),                                              // arrived during
      rec({ seq: 4, atMs: 3_200, startedMs: 3_200, doneMs: 3_210 }),                                              // after it ended
      rec({ seq: 5, atMs: 1_200, startedMs: 1_200, doneMs: null, cls: "shed", code: "shed", e2eMs: null }),       // shed during it: the backlog that shed it is the migration's doing
      rec({ seq: 6, atMs: 3_300, startedMs: 3_300, doneMs: null, cls: "shed", code: "shed", e2eMs: null }),       // shed after it ended
    ];
    expect(overlapping(rs, 1_000, 3_000).map((x) => x.seq)).toEqual([2, 3, 5]);
    expect(startedWithin(rs, 3_000, 5_000).map((x) => x.seq)).toEqual([4, 6]);
    const w = windowStats(overlapping(rs, 1_000, 3_000));
    expect(w).toMatchObject({ requests: 3, errors: 2, errorsByCode: { timeout: 1, shed: 1 } });
    // two requests cannot state a percentile, and the report does not pretend otherwise
    expect(w.e2eMs).toMatchObject({ count: 2, p50: null, p95: null, p99: null, max: { atLeast: 3_150, atMost: 3_150 } });
    expect(windowStats(rs)).toMatchObject({ requests: 6, errors: 3, errorsByCode: { timeout: 1, shed: 2 } });
  });
});

describe("what a migration run is allowed to conclude", () => {
  const ok = (n: number) => windowStats(Array.from({ length: n }, (_, i) => rec({ seq: i })));
  const broken = (n: number, bad: number) => windowStats([...Array.from({ length: n - bad }, (_, i) => rec({ seq: i })), ...Array.from({ length: bad }, () => rec({ cls: "timeout", code: "timeout" }))]);
  const migration = (over: Partial<MigrationWindow>): MigrationWindow => ({ file: "9001_x.sql", kind: "live-safe", attempts: 1, startedAtMs: 0, durationMs: 40, error: null, affected: ok(8), recovery: ok(200), ...over });
  const run = { baseline: ok(200), migrations: [migration({}), migration({ file: "9006_y.sql", kind: "blocking", affected: broken(8, 3) })], fixtures: 1, sweepErrors: 0, sweepTicks: 12, errorsOutsideWindows: 0 };

  it("passes when every live-safe migration met traffic and nothing failed; a blocking one is never judged", () => {
    expect(judgeUnderLoad(run)).toEqual({ verdict: "pass", reasons: [] });
  });
  it("a blocking migration that does not apply is recorded, not judged: five clean live-safe migrations still pass", () => {
    const liveSafe5 = Array.from({ length: 5 }, (_, i) => migration({ file: `900${i + 1}_x.sql` }));
    const blocking = migration({ file: "9006_y.sql", kind: "blocking", error: "lock timeout" });
    expect(judgeUnderLoad({ ...run, migrations: [...liveSafe5, blocking], fixtures: 5 })).toEqual({ verdict: "pass", reasons: [] });
  });
  it("a migration that met nobody proves nothing: inconclusive, not pass", () => {
    const v = judgeUnderLoad({ ...run, migrations: [migration({ affected: ok(0) })], fixtures: 1 });
    expect(v).toEqual({ verdict: "inconclusive", reasons: [expect.stringMatching(/9001_x\.sql: 0 request\(s\) in flight during its 40 ms; at least 5 are needed/)] });
  });
  it("fails on a request lost during a live-safe migration or after it, on one that did not apply, and on fixtures that never ran", () => {
    expect(judgeUnderLoad({ ...run, migrations: [migration({ affected: broken(8, 1) })], fixtures: 1 })).toMatchObject({ verdict: "fail", reasons: [expect.stringMatching(/1 of 8 request\(s\) in flight failed \{"timeout":1\}/)] });
    expect(judgeUnderLoad({ ...run, migrations: [migration({ recovery: broken(200, 2) })], fixtures: 1 }).reasons).toEqual([expect.stringMatching(/2 of 200 request\(s\) after it failed/)]);
    expect(judgeUnderLoad({ ...run, migrations: [migration({ error: "lock timeout" })], fixtures: 5 }).reasons).toEqual(["only 1 of 5 live-safe fixtures ran", expect.stringMatching(/did not apply: lock timeout/)]);
  });
  it("is invalid when the baseline is too small or already failing, the sweeper failed, or requests failed outside every window", () => {
    expect(judgeUnderLoad({ ...run, sweepTicks: 0 })).toEqual({ verdict: "invalid", reasons: ["the sweeper never ran"] });
    // nothing at all: no baseline and no migration is an invalid run, not a pass
    expect(judgeUnderLoad({ ...run, baseline: ok(0), migrations: [], fixtures: 5 }).verdict).toBe("invalid");
    expect(judgeUnderLoad({ ...run, migrations: [], fixtures: 5 })).toEqual({ verdict: "fail", reasons: ["only 0 of 5 live-safe fixtures ran"] });
    expect(judgeUnderLoad({ ...run, baseline: ok(12) })).toMatchObject({ verdict: "invalid", reasons: [expect.stringMatching(/the baseline holds 12 requests; 60 are needed/)] });
    expect(judgeUnderLoad({ ...run, baseline: broken(200, 4) }).reasons).toEqual([expect.stringMatching(/4 request\(s\) failed before any migration began/)]);
    expect(judgeUnderLoad({ ...run, sweepErrors: 1, errorsOutsideWindows: 3 })).toMatchObject({ verdict: "invalid", reasons: ["1 sweeper error(s)", expect.stringMatching(/3 request\(s\) failed outside every migration's windows/)] });
  });
});

describe("migrations under load", () => {
  it("applies the live-safe set without failing a request, records the blocking two, and works on its own database", async () => {
    const hostport = process.env.DASTAR_TEST_PG_HOSTPORT!;
    const adminUrl = `${process.env.DASTAR_TEST_PG_BASE}/postgres`;
    const r = await runMigrateUnderLoad({
      adminUrl, appUrl: `postgres://dastar_app:app@${hostport}/postgres`, workerUrl: `postgres://dastar_worker:worker@${hostport}/postgres`,
      migrationsDir: MIGRATIONS, ratePerSec: 30, baselineSeconds: 4, gapSeconds: 1, preloadRows: 2_000, seed: 41, keep: true, sweep: { everyMs: 500, limit: 20, drain: true },
    });
    try {
      expect(r.database).toMatch(/^dastar_bench_[0-9a-f]{8}$/);
      expect(r.migrations.map((m) => [m.file.slice(0, 4), m.kind, m.error])).toEqual([
        ["9001", "live-safe", null], ["9002", "live-safe", null], ["9003", "live-safe", null], ["9004", "live-safe", null], ["9005", "live-safe", null],
        ["9006", "blocking", null], ["9007", "blocking", null],
      ]);
      expect(r.migrations.every((m) => m.attempts >= 1 && m.durationMs > 0)).toBe(true);
      const liveSafe = r.migrations.filter((m) => m.kind === "live-safe");
      expect(liveSafe.map((m) => [m.affected.errors, m.recovery.errors])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
      expect(r.migrations.every((m) => m.recovery.requests > 0)).toBe(true);
      expect(r.baseline.requests).toBeGreaterThanOrEqual(60);
      expect(r.baseline.errors).toBe(0);
      expect(r.wholeRun.requests).toBeGreaterThan(r.baseline.requests);
      expect(r.wholeRun.errors).toBe(0);
      expect(r.errorsOutsideWindows).toBe(0);
      // at 30 requests a second a migration of a few milliseconds meets almost nobody, and the report says so
      expect(r.thinEvidence).toEqual(r.migrations.filter((m) => m.kind === "live-safe" && m.affected.requests < 5).map((m) => m.file));
      expect(r.sweep.config).toEqual({ everyMs: 500, limit: 20, drain: true });
      // the fixtures applied, and that is all this run may say: at 30 requests a second a migration of a few
      // milliseconds meets almost nobody, so what it shows about traffic is inconclusive, not a pass
      expect(r.fixturesApplied).toBe(true);
      expect(r.thinEvidence.length).toBeGreaterThan(0);
      expect(r.underLoad.verdict).toBe("inconclusive");
      expect(r.underLoad.reasons).toHaveLength(r.thinEvidence.length);

      const c = new Client({ connectionString: withDatabase(adminUrl, r.database) });
      await c.connect();
      const versions = (await c.query("select version from dastar.schema_migration where version >= 9000 order by version")).rows.map((x) => x.version as number);
      expect(versions).toEqual([9001, 9002, 9003, 9004, 9005, 9006, 9007]);
      expect((await c.query("select count(*)::int as n from dastar.reservation where created_by = 'bench:preload' and status = 'confirmed'")).rows[0].n).toBe(2_000);
      // the volatile default filled every existing row, which is what forces the rewrite
      expect((await c.query("select count(*)::int as n from dastar.reservation where bench_rand is null")).rows[0].n).toBe(0);
      expect((await c.query("select convalidated from pg_constraint where conname = 'bench_party_positive'")).rows[0].convalidated).toBe(true);
      expect((await c.query("select i.indisvalid from pg_class k join pg_index i on i.indexrelid = k.oid where k.relname = 'reservation_bench_created_idx'")).rows[0].indisvalid).toBe(true);
      await c.end();
      // the shipped migrations directory was copied, never written to
      const shipped = await import("node:fs/promises").then((fs) => fs.readdir(MIGRATIONS));
      expect(shipped.some((f) => f.startsWith("9"))).toBe(false);
    } finally {
      await dropNaiveDatabase(adminUrl, r.database);
    }
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    expect((await admin.query("select 1 from pg_database where datname = $1", [r.database])).rowCount).toBe(0);
    await admin.end();
  });
});
