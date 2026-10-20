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

  it("maps the admin guards: DA015 to assignment_inactive, DA016 to assignment_in_use, DA017 to invalid_timezone", () => {
    expect(mapPgError({ code: "DA015", message: "assignment a is not active", detail: "reservation=r" }))
      .toMatchObject({ name: "DastarError", code: "assignment_inactive", retryable: false, sqlstate: "DA015", detail: "reservation=r" });
    expect(mapPgError({ code: "DA016", message: "unit u has a live reservation", detail: "reservation=r" }))
      .toMatchObject({ name: "DastarError", code: "assignment_in_use", retryable: false, sqlstate: "DA016", detail: "reservation=r" });
    expect(mapPgError({ code: "DA017", message: "unknown time zone Mars/Olympus" }))
      .toMatchObject({ name: "DastarError", code: "invalid_timezone", retryable: false, sqlstate: "DA017", message: "unknown time zone Mars/Olympus" });
  });

  it("maps a check violation to invalid_input unless the constraint has its own code, and passes the message and detail through", () => {
    expect(mapPgError({ code: "23514", constraint: "unit_capacity_order", message: 'new row for relation "unit" violates check constraint "unit_capacity_order"', detail: "Failing row contains (x)." }))
      .toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false, sqlstate: "23514", message: 'new row for relation "unit" violates check constraint "unit_capacity_order"', detail: "Failing row contains (x)." });
    // no constraint name at all is still a check violation
    expect(mapPgError({ code: "23514", message: "check" })).toMatchObject({ code: "invalid_input", sqlstate: "23514" });
    // a NUL character in text is refused as invalid input, not reported as an internal error
    expect(mapPgError({ code: "22021", message: 'invalid byte sequence for encoding "UTF8": 0x00' })).toMatchObject({ code: "invalid_input", retryable: false, sqlstate: "22021" });
    expect(mapPgError({ code: "23514", constraint: "duration_out_of_range", message: "d" })).toMatchObject({ code: "duration_out_of_range", sqlstate: "23514" });
    expect(mapPgError({ code: "23514", constraint: "combo_too_large", message: "c" })).toMatchObject({ code: "combo_too_large", sqlstate: "23514" });
    // other integrity violations are not check violations
    expect(mapPgError({ code: "23505", message: "unique" })).toBeNull();
  });

  it("maps jsonb text Postgres cannot convert (22P05) to invalid_input", () => {
    expect(mapPgError({ code: "22P05", message: "unsupported Unicode escape sequence", detail: "\\u0000 cannot be converted to text." }))
      .toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false, sqlstate: "22P05", message: "unsupported Unicode escape sequence", detail: "\\u0000 cannot be converted to text." });
  });

  it("maps a foreign key violation on a venue_id_fkey constraint to not_found, and a composite key or another violation code is not", () => {
    // the key a hold's idempotency row has on the venue, and the same shape on any table that references the venue
    for (const constraint of ["idempotency_venue_id_fkey", "unit_venue_id_fkey", "schedule_venue_id_fkey", "blackout_venue_id_fkey", "unit_combo_venue_id_fkey"]) {
      expect(mapPgError({ code: "23503", constraint, message: "violates foreign key", detail: "Key (venue_id)=(x) is not present in table \"venue\"." }), constraint)
        .toMatchObject({ name: "DastarError", code: "not_found", message: "venue not found", retryable: false, sqlstate: "23503", detail: "Key (venue_id)=(x) is not present in table \"venue\"." });
    }
    // a composite key names a row of another table, and the name does not end in _venue_id_fkey
    expect(mapPgError({ code: "23503", constraint: "reservation_unit_venue_id_unit_id_fkey", message: "violates foreign key" })).toBeNull();
    expect(mapPgError({ code: "23503", constraint: "reservation_unit_venue_id_reservation_id_fkey", message: "violates foreign key" })).toBeNull();
    // no constraint name, and the same name under another SQLSTATE
    expect(mapPgError({ code: "23503", message: "violates foreign key" })).toBeNull();
    expect(mapPgError({ code: "23505", constraint: "unit_venue_id_fkey", message: "unique" })).toBeNull();
  });
});
