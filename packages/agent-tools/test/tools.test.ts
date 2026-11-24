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

  it("include no confirm tool; no tool source names a confirm route, and the start-up probes ask the confirm-token route only about a reservation that does not exist, behind an import no tool makes", () => {
    expect(TOOLS.some((t) => t.name.includes("confirm"))).toBe(false);
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const sources = readdirSync(dir).map((f) => ({ f, text: readFileSync(dir + f, "utf8") }));
    for (const { f, text } of sources) {
      if (f !== "startup.ts") expect(text, f).not.toMatch(/\/confirm|confirm[-_]token/);
    }
    const startup = sources.find((s) => s.f === "startup.ts")!.text;
    const calls = startup.split("\n").filter((line) => line.includes('client.POST("/v1/reservations/{id}/confirm-token"'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('client.POST("/v1/reservations/{id}/confirm-token", { params: { path: { id: NO_RESERVATION } }');
    expect(startup).toContain('const NO_RESERVATION = "00000000-0000-0000-0000-000000000000";');
    for (const { f, text } of sources) {
      if (f !== "index.ts") expect(text, f).not.toContain("./startup.js");
    }
  });
});
