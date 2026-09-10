import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";

const STATUSES = ["held", "confirmed", "seated", "completed", "cancelled", "expired"] as const;
type S = (typeof STATUSES)[number];
const ALLOWED = new Set(["held>confirmed", "held>cancelled", "held>expired", "confirmed>seated", "confirmed>cancelled", "seated>completed", "seated>cancelled"]);

describe("state machine", () => {
  let owner: Client; let app: Client; let seed: Seed;
  beforeAll(async () => {
    const c = await cloneDatabase("transitions_test");
    owner = await connect(c.owner);
    app = await connect(c.app);
    await app.query("select set_config('dastar.actor', 'test', false), set_config('dastar.trace_id', 't', false)");
    seed = await seedVenue(owner);
  });
  afterAll(async () => { await app.end(); await owner.end(); await dropDatabase("transitions_test"); });

  let slot = 0;
  async function newHeld(): Promise<string> {
    slot += 1;
    const start = new Date(Date.UTC(2031, 0, 1 + Math.floor(slot / 10), 10 + (slot % 10)));
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const during = `[${start.toISOString()},${end.toISOString()})`;
    await app.query("begin");
    const id = (await app.query(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'test') returning id`,
      [seed.venue, during, seed.units[0]])).rows[0].id as string;
    await app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)",
      [seed.venue, id, seed.units[0], during]);
    await app.query("commit");
    return id;
  }

  async function drive(id: string, to: S): Promise<void> {
    const path: Record<S, S[]> = {
      held: [], confirmed: ["confirmed"], seated: ["confirmed", "seated"], completed: ["confirmed", "seated", "completed"],
      cancelled: ["cancelled"], expired: ["expired"],
    };
    for (const step of path[to]) {
      if (step === "expired") {
        await setClock(app, "2040-01-01T00:00:00Z");
        await app.query("update dastar.reservation set status = 'expired' where id = $1", [id]);
        await setClock(app, null);
      } else {
        await app.query("update dastar.reservation set status = $2::dastar.reservation_status, cancel_reason = case when $2::dastar.reservation_status = 'cancelled' then 'test' end where id = $1", [id, step]);
      }
    }
  }

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      it(`${from} -> ${to}`, async () => {
        const id = await newHeld();
        await drive(id, from);
        const before = (await app.query("select version from dastar.reservation where id = $1", [id])).rows[0].version as number;
        if (from === "held" && to === "expired") await setClock(app, "2040-01-01T00:00:00Z");
        const attempt = app.query("update dastar.reservation set status = $2, cancel_reason = coalesce(cancel_reason, 'test') where id = $1", [id, to]);
        attempt.catch(() => undefined);
        if (from === "held" && to === "expired") { await attempt.catch(() => undefined); await setClock(app, null); }
        if (from === to) {
          await attempt;
          const after = (await app.query("select version, status from dastar.reservation where id = $1", [id])).rows[0];
          expect(after.status).toBe(from);
          expect(after.version).toBe(before + 1);
        } else if (ALLOWED.has(`${from}>${to}`)) {
          await attempt;
          const after = (await app.query("select version, status, confirm_token_hash from dastar.reservation where id = $1", [id])).rows[0];
          expect(after.status).toBe(to);
          expect(after.version).toBe(before + 1);
          if (from === "held") expect(after.confirm_token_hash).toBeNull();
        } else {
          await expect(attempt).rejects.toMatchObject({ code: "DA005" });
        }
      });
    }
  }

  it("held -> expired is refused before expiry", async () => {
    const id = await newHeld();
    await expect(app.query("update dastar.reservation set status = 'expired' where id = $1", [id])).rejects.toMatchObject({ code: "DA005" });
  });
});
