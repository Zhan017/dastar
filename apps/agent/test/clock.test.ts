import { describe, it, expect } from "vitest";
import { venueClock } from "../src/clock.js";

describe("venueClock", () => {
  it("reads the venue's weekday, local time and offset in winter", () => {
    expect(venueClock("2064-01-07T16:00:00Z", "Europe/Berlin")).toEqual({ weekday: "Monday", local: "2064-01-07 17:00", offset: "+01:00" });
  });

  it("follows daylight saving time", () => {
    expect(venueClock("2064-07-07T16:00:00Z", "Europe/Berlin")).toEqual({ weekday: "Monday", local: "2064-07-07 18:00", offset: "+02:00" });
  });

  it("writes an offset that is not whole hours, and UTC as +00:00", () => {
    expect(venueClock("2064-01-07T16:00:00Z", "Asia/Kathmandu")).toEqual({ weekday: "Monday", local: "2064-01-07 21:45", offset: "+05:45" });
    expect(venueClock("2064-01-07T16:00:00Z", "UTC")).toEqual({ weekday: "Monday", local: "2064-01-07 16:00", offset: "+00:00" });
  });

  it("writes an offset west of UTC with a minus", () => {
    expect(venueClock("2064-01-07T16:00:00Z", "America/New_York")).toEqual({ weekday: "Monday", local: "2064-01-07 11:00", offset: "-05:00" });
  });

  it("reads midnight as 00:00, not 24:00, and takes the date from the venue's clock", () => {
    expect(venueClock("2064-01-07T23:00:00Z", "Europe/Berlin")).toEqual({ weekday: "Tuesday", local: "2064-01-08 00:00", offset: "+01:00" });
    expect(venueClock("2064-01-08T00:00:00Z", "UTC").local).toBe("2064-01-08 00:00");
  });
});
