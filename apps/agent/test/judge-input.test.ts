import { describe, it, expect } from "vitest";
import type { LoggedCall } from "@dastar/db";
import { USER_TEXT_CHARS, buildJudgeInput, venueInstant } from "../src/judge/input.js";

const R1 = "0199a000-0000-7000-8000-0000000000c1";
const R2 = "0199a000-0000-7000-8000-0000000000c2";
const BERLIN = "Europe/Berlin";

const call = (over: Partial<LoggedCall> & Pick<LoggedCall, "id" | "tool">): LoggedCall => ({
  input: null, status: 200, output: null, receipt: null, receiptVerified: null, completedAt: "2064-01-01T10:00:00Z", ...over,
});

/** A hold the session made: the reservation's id, the start and party size it asked for. */
const hold = (id: number, reservation: string, startsAt: string, partySize?: number): LoggedCall =>
  call({
    id, tool: "hold", status: 201,
    input: { starts_at: startsAt, ...(partySize === undefined ? {} : { party_size: partySize }) },
    output: { hold_expires_at: "2064-12-31T00:00:00Z" },
    receipt: { reservation_id: reservation, status: "held" },
    completedAt: `2064-01-01T10:00:0${id}Z`,
  });

const source = (over: Partial<Parameters<typeof buildJudgeInput>[0]> = {}): Parameters<typeof buildJudgeInput>[0] => ({
  text: "I've put a hold on 18:00 for two.", userText: "A table for two, please.", claims: null, calls: [], timeZone: BERLIN, ...over,
});

describe("buildJudgeInput", () => {
  it("lists the reservations the calls showed with start times in the venue's offset", () => {
    const input = buildJudgeInput(source({ calls: [hold(1, R1, "2064-01-07T17:00:00Z", 2), hold(2, R2, "2064-07-07T16:00:00Z", 4)] }));
    expect(input.reservations).toEqual([
      { id: R1, starts_at: "2064-01-07T18:00:00+01:00", party_size: 2 },
      { id: R2, starts_at: "2064-07-07T18:00:00+02:00", party_size: 4 },
    ]);
    expect(input.assistant_text).toBe("I've put a hold on 18:00 for two.");
    expect(input.user_text).toBe("A table for two, please.");
    expect(input.claims).toEqual([]);
  });

  it("lists nothing for a session with no calls", () => {
    expect(buildJudgeInput(source()).reservations).toEqual([]);
  });

  it("a reservation seen without a party size has party_size null", () => {
    const seen = call({ id: 3, tool: "get_reservation", output: { id: R1, status: "held", starts_at: "2064-01-07T17:00:00Z" } });
    expect(buildJudgeInput(source({ calls: [seen] })).reservations).toEqual([{ id: R1, starts_at: "2064-01-07T18:00:00+01:00", party_size: null }]);
    expect(buildJudgeInput(source({ calls: [hold(1, R1, "2064-01-07T17:00:00Z")] })).reservations).toEqual([
      { id: R1, starts_at: "2064-01-07T18:00:00+01:00", party_size: null },
    ]);
  });

  it("a start the calls recorded that is not an instant gives null", () => {
    expect(buildJudgeInput(source({ calls: [hold(1, R1, "tomorrow evening", 2)] })).reservations).toEqual([{ id: R1, starts_at: null, party_size: 2 }]);
  });

  it("the user text is cut to 2,000 characters", () => {
    expect(USER_TEXT_CHARS).toBe(2_000);
    expect(buildJudgeInput(source({ userText: "a".repeat(2_500) })).user_text).toBe("a".repeat(2_000));
    expect(buildJudgeInput(source({ userText: "a".repeat(2_000) })).user_text).toBe("a".repeat(2_000));
    expect(buildJudgeInput(source({ userText: "short" })).user_text).toBe("short");
    expect(buildJudgeInput(source({ userText: null })).user_text).toBeNull();
    // a character outside the basic plane is one character, and is not cut in two
    expect(buildJudgeInput(source({ userText: "\u{1F600}".repeat(2_001) })).user_text).toBe("\u{1F600}".repeat(2_000));
  });

  it("the assistant text is kept whole", () => {
    const text = "word ".repeat(10_000);
    expect(buildJudgeInput(source({ text })).assistant_text).toBe(text);
  });

  it("claims of the wrong shape are left out and ids lowercased", () => {
    const input = buildJudgeInput(
      source({
        claims: [
          { reservation_id: R1.toUpperCase(), status: "held", starts_at: "2064-01-07T17:00:00Z", party_size: 2, quote: "a hold" },
          { reservation_id: R2, status: "confirmed" },
          { reservation_id: 7, status: "held" },
          { reservation_id: "", status: "held" },
          { reservation_id: R1, status: "booked" },
          { reservation_id: R1, status: "held", party_size: "2" },
          { reservation_id: R1, status: "held", party_size: Number.NaN },
          { reservation_id: R1, status: "held", starts_at: 19 },
          "held",
          null,
          [R1, "held"],
        ],
      }),
    );
    expect(input.claims).toEqual([
      { reservation_id: R1, status: "held", starts_at: "2064-01-07T17:00:00Z", party_size: 2 },
      { reservation_id: R2, status: "confirmed" },
    ]);
    expect(buildJudgeInput(source({ claims: null })).claims).toEqual([]);
    expect(buildJudgeInput(source({ claims: [] })).claims).toEqual([]);
  });
});

describe("venueInstant", () => {
  it("writes an instant with the venue's offset, following daylight saving time", () => {
    expect(venueInstant("2064-01-07T17:00:00Z", BERLIN)).toBe("2064-01-07T18:00:00+01:00");
    expect(venueInstant("2064-07-07T16:00:00Z", BERLIN)).toBe("2064-07-07T18:00:00+02:00");
    expect(venueInstant("2064-01-07T19:00:00+02:00", BERLIN)).toBe("2064-01-07T18:00:00+01:00");
    expect(venueInstant("2064-01-07T17:00:00.000Z", BERLIN)).toBe("2064-01-07T18:00:00+01:00");
    expect(venueInstant("2064-01-07T17:00Z", BERLIN)).toBe("2064-01-07T18:00:00+01:00");
    expect(venueInstant("2064-01-07T17:00:30Z", BERLIN)).toBe("2064-01-07T18:00:30+01:00");
    expect(venueInstant("2064-01-07T17:00:00Z", "UTC")).toBe("2064-01-07T17:00:00+00:00");
    expect(venueInstant("2064-01-07T17:00:00Z", "Asia/Kathmandu")).toBe("2064-01-07T22:45:00+05:45");
    expect(venueInstant("2064-01-07T17:00:00Z", "America/New_York")).toBe("2064-01-07T12:00:00-05:00");
  });

  it("takes the date from the venue's clock", () => {
    expect(venueInstant("2064-01-07T23:30:00Z", BERLIN)).toBe("2064-01-08T00:30:00+01:00");
  });

  it("a value that is not an instant gives null", () => {
    for (const value of ["", "tomorrow", "19:00", "2064-01-07", "2064-01-07T18:00:00", "2064-01-07 18:00:00Z", "not 2064-01-07T18:00:00Z"]) {
      expect(venueInstant(value, BERLIN), value).toBeNull();
    }
  });
});
