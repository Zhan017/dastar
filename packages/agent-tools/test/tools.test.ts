import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { INPUT_SCHEMAS, TOOLS } from "../src/index.js";

describe("the tool definitions", () => {
  it("are exactly the four tools, each with its committed input schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["search_availability", "hold", "cancel", "get_reservation"]);
    for (const t of TOOLS) expect(t.inputSchema).toBe(INPUT_SCHEMAS[t.name]);
  });

  it("say what each tool does to the venue", () => {
    expect(Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]))).toEqual({
      search_availability: { readOnlyHint: true },
      hold: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      cancel: { readOnlyHint: false, destructiveHint: true },
      get_reservation: { readOnlyHint: true },
    });
  });

  it("tell a model that a person confirms a hold and that cancel is for the session's own reservations", () => {
    const d = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
    expect(d.hold).toContain("a person must confirm it through the venue's own channel");
    expect(d.hold).toContain("hold_expires_at");
    expect(d.cancel).toContain("only reservations this session created");
  });

  it("include no confirm tool, and no source file names a confirm route", () => {
    expect(TOOLS.some((t) => t.name.includes("confirm"))).toBe(false);
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const f of readdirSync(dir)) expect(readFileSync(dir + f, "utf8"), f).not.toMatch(/\/confirm|confirm[-_]token/);
  });
});
