import { describe, it, expect } from "vitest";
import { mapPgError, STORED_OUTCOMES } from "../src/errors.js";

describe("mapPgError", () => {
  it("maps a row-level security violation to venue_scope_violation and every other 42501 to forbidden_write", () => {
    expect(mapPgError({ code: "42501", message: 'new row violates row-level security policy for table "reservation"' }))
      .toMatchObject({ name: "DastarError", code: "venue_scope_violation", retryable: false, sqlstate: "42501" });
    expect(mapPgError({ code: "42501", message: 'permission denied for table "reservation"' }))
      .toMatchObject({ code: "forbidden_write", retryable: false, sqlstate: "42501" });
    expect(mapPgError({ code: "42501" })).toMatchObject({ code: "forbidden_write", sqlstate: "42501" });
  });

  it("maps the blackout guards: DA009 to blackout, which a hold stores, and DA014 to blackout_conflict, which it does not", () => {
    expect(mapPgError({ code: "DA009", message: "reservation range overlaps an active blackout of the venue" }))
      .toMatchObject({ name: "DastarError", code: "blackout", retryable: false, sqlstate: "DA009" });
    expect(mapPgError({ code: "DA014", message: "blackout would strand a live reservation", detail: "reservation=r" }))
      .toMatchObject({ name: "DastarError", code: "blackout_conflict", retryable: false, sqlstate: "DA014", detail: "reservation=r" });
    expect(STORED_OUTCOMES.has("blackout")).toBe(true);
    expect(STORED_OUTCOMES.has("blackout_conflict")).toBe(false);
  });
});
