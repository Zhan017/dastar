import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold } from "../src/commands/hold.js";
import { getReservation } from "../src/commands/get.js";
import { listHolds } from "../src/commands/list-holds.js";

describe("the start of a reservation as an instant", () => {
  let conn: Conn; let owner: Client; let app: Client; let reader: Client;
  let V: Seed;
  const ACTOR = "key:starts-at";

  beforeAll(async () => {
    conn = await cloneDatabase("starts_at_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    reader = await connect(conn.app);
    V = await seedVenue(owner);
    await reader.query("set timezone = 'Asia/Tokyo'");
  });
  afterAll(async () => {
    await reader.query("reset timezone");
    await reader.end(); await app.end(); await owner.end();
    await dropDatabase("starts_at_test");
  });

  it("the reservation read and the hold list give startsAt, the start of during as an instant, whatever the connection's time zone", async () => {
    const out = await hold(app, {
      venueId: V.venue, actor: ACTOR, traceId: "sa-t1", idempotencyKey: "sa-k1",
      partySize: 2, startsAt: "2064-01-07T19:00:00+02:00", durationMinutes: 90, assignment: { kind: "unit", id: V.units[0]! },
    });
    if (!out.ok) throw new Error(out.error.code);

    const read = await getReservation(reader, { reservationId: out.receipt.reservationId, venueId: V.venue });
    expect(read).not.toBeNull();
    expect(read!.startsAt).toBe("2064-01-07T17:00:00.000Z");
    // during is the range's text in the connection's zone; startsAt does not follow it
    expect(read!.during).toContain("+09");

    const listed = await listHolds(reader, { venueId: V.venue, actor: ACTOR });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(out.receipt.reservationId);
    expect(listed[0]!.startsAt).toBe("2064-01-07T17:00:00.000Z");
    expect(listed[0]!.during).toContain("+09");
  });
});
