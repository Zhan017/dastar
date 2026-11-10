import { describe, it, expect, beforeEach } from "vitest";
import { canonicalHoldRequest } from "@dastar/core";
import { createToolSession, normalizeHold, type HoldArgs } from "../src/index.js";
import { fakeApi, json, problem } from "./fake-api.js";

const VENUE = "0199a000-0000-7000-8000-000000000001";
const OTHER_VENUE = "0199a000-0000-7000-8000-000000000002";
const UNIT = "0199a000-0000-7000-8000-000000000101";
const RES = "0199a000-0000-7000-8000-0000000000a1";
const RES_B = "0199a000-0000-7000-8000-0000000000b2";
const RES_C = "0199a000-0000-7000-8000-0000000000c3";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST: HoldArgs = { party_size: 2, starts_at: "2064-01-07T16:00:00Z", duration_minutes: 90, assignment: { kind: "unit", id: UNIT } };
const EXPIRES = "2064-01-07T12:10:00.000Z";

const held = (id = RES, replayed = false): Response =>
  json(201, { receipt: { reservation_id: id, status: "held", version: 1, audit_id: 1, trace_id: "t-1" }, hold_expires_at: EXPIRES, replayed });
const reservation = (status: string, venue = VENUE, id = RES): Response =>
  json(200, { id, venue_id: venue, status, stored_status: status, party_size: 2, during: '["2064-01-07 16:00:00+00","2064-01-07 17:30:00+00")', assignment: { kind: "unit", id: UNIT }, hold_expires_at: EXPIRES, version: 1, external_ref: null, history: [] });
const cancelledReceipt = (id = RES): Response => json(200, { receipt: { reservation_id: id, status: "cancelled", version: 2, audit_id: 2, trace_id: "t-2" } });
const firstLine = (text: string): string => text.split("\n")[0]!;

let t = 0;
const now = (): number => t;
beforeEach(() => { t = Date.parse("2064-01-07T12:00:00Z"); });
const sessionOver = (api: ReturnType<typeof fakeApi>, venueId = VENUE) => createToolSession({ client: api.client, venueId, now, timeoutMs: 50 });

describe("normalizeHold", () => {
  it("is core's canonical form without the venue, however the request is spelled", () => {
    const spellings: HoldArgs[] = [
      REQUEST,
      { ...REQUEST, starts_at: "2064-01-07T17:00:00+01:00" },
      { ...REQUEST, starts_at: "2064-01-07T16:00:00.000Z", assignment: { kind: "unit", id: UNIT.toUpperCase() } },
    ];
    const core = JSON.parse(canonicalHoldRequest({
      venueId: VENUE, actor: "key:x", traceId: "t", idempotencyKey: "k",
      partySize: 2, startsAt: REQUEST.starts_at, durationMinutes: 90, assignment: { kind: "unit", id: UNIT },
    })) as Record<string, unknown>;
    delete core.venueId;
    expect(new Set(spellings.map((s) => normalizeHold(s).intent))).toEqual(new Set([JSON.stringify(core)]));
  });

  it("sends the normalized request", () => {
    expect(normalizeHold({ ...REQUEST, starts_at: "2064-01-07T17:00:00+01:00", assignment: { kind: "unit", id: UNIT.toUpperCase() } }).body)
      .toEqual({ party_size: 2, starts_at: "2064-01-07T16:00:00.000Z", duration_minutes: 90, assignment: { kind: "unit", id: UNIT } });
  });

  it("keeps external_ref, and a different one is a different intent", () => {
    const a = normalizeHold({ ...REQUEST, external_ref: "window table" });
    expect(a.body.external_ref).toBe("window table");
    expect(a.intent).not.toBe(normalizeHold(REQUEST).intent);
    expect(a.intent).not.toBe(normalizeHold({ ...REQUEST, external_ref: "patio" }).intent);
  });

  it("leaves a starts_at that is not a date as it is", () => {
    expect(normalizeHold({ ...REQUEST, starts_at: "tomorrow" }).body.starts_at).toBe("tomorrow");
  });
});

describe("hold keys", () => {
  it("reuse the key after no answer: a transport error, a timeout, a 503, and a serialization conflict", async () => {
    const api = fakeApi(new TypeError("fetch failed"), "hang", problem(503, "pool_timeout"), problem(409, "serialization_conflict"), held());
    const s = sessionOver(api);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await s.hold(REQUEST));
    expect(results.slice(0, 4).map((r) => r.structured.code)).toEqual(["transport_error", "transport_error", "pool_timeout", "serialization_conflict"]);
    for (const r of results.slice(0, 4)) {
      expect(r.isError).toBe(true);
      expect(firstLine(r.text)).toMatch(/ Repeating the same request is safe\.$/);
    }
    expect(firstLine(results[0]!.text)).toBe("No answer from the venue's API: fetch failed. Repeating the same request is safe.");
    expect(firstLine(results[1]!.text)).toBe("No answer from the venue's API: no response within 0.05 seconds. Repeating the same request is safe.");
    expect(results[4]!.isError).toBe(false);
    const keys = api.seen.map((x) => x.key);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID);
  });

  it("reuse the key while the hold is live, and a replay reports the reservation's current status", async () => {
    const api = fakeApi(held(), held(RES, true), reservation("confirmed"));
    const s = sessionOver(api);
    const first = await s.hold(REQUEST);
    t += 60_000;
    const again = await s.hold({ ...REQUEST, starts_at: "2064-01-07T17:00:00+01:00" });
    expect(api.seen.map((x) => [x.method, x.path])).toEqual([
      ["POST", `/v1/venues/${VENUE}/holds`], ["POST", `/v1/venues/${VENUE}/holds`], ["GET", `/v1/reservations/${RES}`],
    ]);
    expect(api.seen[1]!.key).toBe(api.seen[0]!.key);
    expect(api.seen[1]!.body).toEqual(api.seen[0]!.body);
    expect(firstLine(first.text)).toBe(`Held reservation ${RES} until ${EXPIRES}. It is not booked until a person confirms it through the venue; otherwise it expires then.`);
    expect(first.structured).toEqual({ receipt: { reservation_id: RES, status: "held", version: 1, audit_id: 1, trace_id: "t-1" }, hold_expires_at: EXPIRES, replayed: false });
    expect(again.structured).toMatchObject({ replayed: true, current_status: "confirmed", receipt: { reservation_id: RES } });
    expect(firstLine(again.text)).toBe(`This hold was already made: reservation ${RES} is confirmed now.`);
  });

  it("report a replay whose read fails without a current status", async () => {
    const api = fakeApi(held(), held(RES, true), problem(503, "timeout"));
    const s = sessionOver(api);
    await s.hold(REQUEST);
    const again = await s.hold(REQUEST);
    expect(again.isError).toBe(false);
    expect(again.structured).not.toHaveProperty("current_status");
    expect(firstLine(again.text)).toBe(`This hold was already made: reservation ${RES}, held until ${EXPIRES}; its current status could not be read.`);
  });

  it("change after a stored refusal, too many live holds, and any other 4xx", async () => {
    const api = fakeApi(problem(409, "hold_conflict", { replayed: false }), problem(429, "too_many_live_holds"), problem(422, "outside_schedule"), held());
    const s = sessionOver(api);
    const conflict = await s.hold(REQUEST);
    for (let i = 0; i < 3; i++) await s.hold(REQUEST);
    expect(conflict).toMatchObject({ isError: true, structured: { code: "hold_conflict", status: 409, detail: "hold conflict", trace_id: "t-1", replayed: false } });
    expect(firstLine(conflict.text)).toBe("Refused: hold_conflict (hold conflict).");
    expect(new Set(api.seen.map((x) => x.key)).size).toBe(4);
  });

  it("change once the hold's expiry is no longer in the future by the session clock", async () => {
    const api = fakeApi(held(), held(RES_B));
    const s = sessionOver(api);
    await s.hold(REQUEST);
    t = Date.parse(EXPIRES);
    await s.hold(REQUEST);
    expect(api.seen[1]!.key).not.toBe(api.seen[0]!.key);
  });

  it("change after the session's own cancel", async () => {
    const api = fakeApi(held(), cancelledReceipt(), held(RES_B));
    const s = sessionOver(api);
    await s.hold(REQUEST);
    await s.cancel({ reservation_id: RES, reason: "plans changed" });
    await s.hold(REQUEST);
    expect(api.seen[1]).toMatchObject({ method: "POST", path: `/v1/reservations/${RES}/cancel`, body: { reason: "plans changed" } });
    expect(api.seen[2]!.key).not.toBe(api.seen[0]!.key);
  });

  it("change when a replay shows the reservation cancelled", async () => {
    const api = fakeApi(held(), held(RES, true), reservation("cancelled"), held(RES_B));
    const s = sessionOver(api);
    await s.hold(REQUEST);
    await s.hold(REQUEST);
    await s.hold(REQUEST);
    expect(api.seen[1]!.key).toBe(api.seen[0]!.key);
    expect(api.seen[3]!.key).not.toBe(api.seen[0]!.key);
  });

  it("differ between intents, and two sessions never share a key", async () => {
    const api = fakeApi(held(), held(RES_B), held(RES_C));
    const a = sessionOver(api);
    const b = sessionOver(api);
    await a.hold(REQUEST);
    await a.hold({ ...REQUEST, party_size: 3 });
    await b.hold(REQUEST);
    expect(new Set(api.seen.map((x) => x.key)).size).toBe(3);
  });
});

describe("other answers", () => {
  it("an error body that is not Problem Details is reported with its status, and a 5xx keeps the key", async () => {
    const api = fakeApi(new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }), held());
    const s = sessionOver(api);
    const r = await s.hold(REQUEST);
    await s.hold(REQUEST);
    expect(r).toMatchObject({ isError: true, structured: { code: "unexpected_response", status: 502, detail: "HTTP 502 without Problem Details" } });
    expect(firstLine(r.text)).toBe("Refused: unexpected_response (HTTP 502 without Problem Details). Repeating the same request is safe.");
    expect(api.seen[1]!.key).toBe(api.seen[0]!.key);
  });

  it("a starts_at that is not a date reaches the API unchanged, and its refusal is a result, not a throw", async () => {
    const api = fakeApi(problem(400, "validation"));
    const r = await sessionOver(api).hold({ ...REQUEST, starts_at: "tomorrow" });
    expect(api.seen[0]!.body).toMatchObject({ starts_at: "tomorrow" });
    expect(r).toMatchObject({ isError: true, structured: { code: "validation", status: 400 } });
  });

  it("an answer without the expected body keeps the key and is a result, not a throw", async () => {
    const api = fakeApi(new Response(null, { status: 204 }), json(201, { receipt: {} }), held(), json(200, { id: RES }));
    const s = sessionOver(api);
    const empty = await s.hold(REQUEST);
    const partial = await s.hold(REQUEST);
    const made = await s.hold(REQUEST);
    const read = await s.getReservation({ reservation_id: RES });
    expect(empty).toMatchObject({ isError: true, structured: { code: "transport_error" } });
    expect(partial).toMatchObject({ isError: true, structured: { code: "transport_error", detail: "HTTP 201 without the expected body" } });
    expect(firstLine(partial.text)).toBe("No answer from the venue's API: HTTP 201 without the expected body. Repeating the same request is safe.");
    expect(made.isError).toBe(false);
    expect(read).toMatchObject({ isError: true, structured: { code: "transport_error", detail: "HTTP 200 without the expected body" } });
    expect(new Set(api.seen.slice(0, 3).map((x) => x.key)).size).toBe(1);
  });
});

describe("cancel", () => {
  it("refuses a reservation this session did not create, without a request", async () => {
    const api = fakeApi();
    const r = await sessionOver(api).cancel({ reservation_id: RES, reason: "not mine" });
    expect(api.seen).toEqual([]);
    expect(r).toEqual({
      isError: true,
      text: `Refused: not_created_in_session (this session did not create reservation ${RES}, so it cannot cancel it).\n${JSON.stringify({ code: "not_created_in_session", reservation_id: RES })}`,
      structured: { code: "not_created_in_session", reservation_id: RES },
    });
  });

  it("matches its own reservations whatever their case, and passes expected_version", async () => {
    const api = fakeApi(held(), cancelledReceipt());
    const s = sessionOver(api);
    await s.hold(REQUEST);
    const r = await s.cancel({ reservation_id: RES.toUpperCase(), reason: "plans changed", expected_version: 1 });
    expect(api.seen[1]).toMatchObject({ path: `/v1/reservations/${RES}/cancel`, body: { reason: "plans changed", expected_version: 1 } });
    expect(firstLine(r.text)).toBe(`Cancelled reservation ${RES}.`);
  });
});

describe("get_reservation and search_availability", () => {
  it("reads a reservation of the bound venue, through call as well", async () => {
    const api = fakeApi(reservation("held"), reservation("held"));
    const s = sessionOver(api, VENUE.toUpperCase());
    const direct = await s.getReservation({ reservation_id: RES });
    const called = await s.call("get_reservation", { reservation_id: RES });
    expect(direct).toEqual(called);
    expect(direct.isError).toBe(false);
    expect(firstLine(direct.text)).toBe(`Reservation ${RES} is held.`);
    expect(direct.structured).toMatchObject({ id: RES, venue_id: VENUE });
  });

  it("answers not_found for a reservation of another venue", async () => {
    const r = await sessionOver(fakeApi(reservation("held", OTHER_VENUE))).getReservation({ reservation_id: RES });
    expect(r).toMatchObject({ isError: true, structured: { code: "not_found", status: 404, detail: "no reservation with this id in this venue" } });
    expect(firstLine(r.text)).toBe("Refused: not_found (no reservation with this id in this venue).");
  });

  it("searches the bound venue with the arguments as the body", async () => {
    const slot = { starts_at: "2064-01-07T16:00:00.000Z", duration_minutes: 90, assignment: { kind: "unit", id: UNIT } };
    const api = fakeApi(json(200, { slots: [slot], truncated: true }), json(200, { slots: [], truncated: false }));
    const s = sessionOver(api, VENUE.toUpperCase());
    const args = { party_size: 2, from: "2064-01-07T00:00:00Z", to: "2064-01-08T00:00:00Z", limit: 1 };
    const found = await s.searchAvailability(args);
    const none = await s.searchAvailability(args);
    expect(api.seen[0]).toMatchObject({ method: "POST", path: `/v1/venues/${VENUE}/availability`, body: args });
    expect(firstLine(found.text)).toBe("Found 1 slot; the search stopped at a limit, so more may exist.");
    expect(found.structured).toEqual({ slots: [slot], truncated: true });
    expect(firstLine(none.text)).toBe("No slots found for a party of 2 in that window.");
  });
});
