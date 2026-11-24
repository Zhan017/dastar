import { describe, it, expect } from "vitest";
import { fallbackReply, type FallbackRead } from "../src/fallback.js";

const ID1 = "0199a000-0000-7000-8000-0000000000c1";
const ID2 = "0199a000-0000-7000-8000-0000000000c2";
const AT1 = "2064-01-07T18:00:00Z"; // 19:00 in Berlin
const AT2 = "2064-01-07T19:00:00Z";
const SORRY = "Sorry, I could not complete that request.";

describe("fallbackReply", () => {
  it("lists each reservation as read, in the venue's time, and claims what was read", () => {
    const reads: FallbackRead[] = [
      { reservationId: ID1, reservation: { status: "held", starts_at: AT1, party_size: 2 } },
      { reservationId: ID2, reservation: { status: "cancelled", starts_at: AT2, party_size: 4 } },
    ];
    expect(fallbackReply(reads, "Europe/Berlin")).toEqual({
      message: [
        `${SORRY} Here is where this conversation's reservations stand:`,
        `- ${ID1}: held, party of 2, Monday 2064-01-07 19:00 (Europe/Berlin).`,
        `- ${ID2}: cancelled, party of 4, Monday 2064-01-07 20:00 (Europe/Berlin).`,
      ].join("\n"),
      claims: [
        { reservation_id: ID1, status: "held", starts_at: AT1, party_size: 2 },
        { reservation_id: ID2, status: "cancelled", starts_at: AT2, party_size: 4 },
      ],
    });
  });

  it("a reservation that could not be read is named without a claim", () => {
    const reads: FallbackRead[] = [
      { reservationId: ID1, reservation: null },
      { reservationId: ID2, reservation: { status: "held", starts_at: AT1, party_size: 2 } },
    ];
    expect(fallbackReply(reads, "Europe/Berlin")).toEqual({
      message: [
        `${SORRY} Here is where this conversation's reservations stand:`,
        `- ${ID1}: could not be read just now.`,
        `- ${ID2}: held, party of 2, Monday 2064-01-07 19:00 (Europe/Berlin).`,
      ].join("\n"),
      claims: [{ reservation_id: ID2, status: "held", starts_at: AT1, party_size: 2 }],
    });
  });

  it("with no reservations it says so", () => {
    expect(fallbackReply([], "Europe/Berlin")).toEqual({
      message: `${SORRY} No reservation has been made in this conversation.`,
      claims: [],
    });
  });

  it("a status outside the claim statuses is named but not claimed", () => {
    const reads: FallbackRead[] = [{ reservationId: ID1, reservation: { status: "no_show", starts_at: AT1, party_size: 2 } }];
    expect(fallbackReply(reads, "Europe/Berlin")).toEqual({
      message: [
        `${SORRY} Here is where this conversation's reservations stand:`,
        `- ${ID1}: no_show, party of 2, Monday 2064-01-07 19:00 (Europe/Berlin).`,
      ].join("\n"),
      claims: [],
    });
  });

  it("a start time that is not a time is given as it was read", () => {
    const reads: FallbackRead[] = [{ reservationId: ID1, reservation: { status: "held", starts_at: "soon", party_size: 2 } }];
    expect(fallbackReply(reads, "Europe/Berlin").message).toContain(`- ${ID1}: held, party of 2, soon.`);
  });
});
