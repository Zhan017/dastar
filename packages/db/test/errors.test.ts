import { describe, it, expect } from "vitest";
import { mapPgError } from "../src/errors.js";

describe("mapPgError", () => {
  it("maps a row-level security violation to venue_scope_violation and every other 42501 to forbidden_write", () => {
    expect(mapPgError({ code: "42501", message: 'new row violates row-level security policy for table "reservation"' }))
      .toMatchObject({ name: "DastarError", code: "venue_scope_violation", retryable: false, sqlstate: "42501" });
    expect(mapPgError({ code: "42501", message: 'permission denied for table "reservation"' }))
      .toMatchObject({ code: "forbidden_write", retryable: false, sqlstate: "42501" });
    expect(mapPgError({ code: "42501" })).toMatchObject({ code: "forbidden_write", sqlstate: "42501" });
  });
});
