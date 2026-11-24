import { describe, it, expect } from "vitest";
import { INPUT_SCHEMAS, TOOLS } from "@dastar/agent-tools";
import { AGENT_INPUT_SCHEMAS, AGENT_TOOLS, KNOWN_KEYWORDS, strictSchema, validateArgs } from "../src/tools.js";

type Node = Record<string, unknown>;

/** Every schema node under `node`, with its dotted path ("" for the root): the node itself, then the nodes under its properties. */
function* walk(node: Node, path = ""): Generator<[string, Node]> {
  yield [path, node];
  const properties = (node["properties"] ?? {}) as Record<string, Node>;
  for (const [name, child] of Object.entries(properties)) yield* walk(child, path === "" ? name : `${path}.${name}`);
}

const UUID = "0199a000-0000-7000-8000-0000000000c1";
const HOLD = { party_size: 2, starts_at: "2064-01-07T19:00:00Z", duration_minutes: 90, assignment: { kind: "unit", id: UUID } };

describe("the input schemas", () => {
  it("every keyword the input schemas use is one the check knows", () => {
    for (const [tool, schema] of Object.entries(INPUT_SCHEMAS)) {
      for (const [path, node] of walk(schema)) {
        for (const keyword of Object.keys(node)) expect(KNOWN_KEYWORDS.has(keyword), `${tool} ${path}: ${keyword}`).toBe(true);
        if ("format" in node) expect(["uuid", "date-time"], `${tool} ${path}`).toContain(node["format"]);
      }
    }
    expect([...KNOWN_KEYWORDS].sort()).toEqual(["enum", "format", "maxLength", "maximum", "minLength", "minimum", "properties", "required", "type"]);
  });

  it("the hold tool takes no external_ref", () => {
    expect(INPUT_SCHEMAS.hold.properties).toHaveProperty("external_ref");
    expect(AGENT_INPUT_SCHEMAS.hold["properties"]).not.toHaveProperty("external_ref");
    expect(AGENT_INPUT_SCHEMAS.hold["required"]).toEqual(INPUT_SCHEMAS.hold.required);
    expect(Object.keys(AGENT_INPUT_SCHEMAS.hold["properties"] as Node)).toEqual(["party_size", "starts_at", "duration_minutes", "assignment"]);
    for (const name of ["search_availability", "cancel", "get_reservation"] as const) expect(AGENT_INPUT_SCHEMAS[name]).toEqual(INPUT_SCHEMAS[name]);
  });
});

describe("the tools as a provider takes them", () => {
  it("strict schemas keep the shape, drop the limits and close every object", () => {
    const before = structuredClone(INPUT_SCHEMAS);
    const agentBefore = structuredClone(AGENT_INPUT_SCHEMAS);
    const kept = (schema: Node) =>
      [...walk(schema)].flatMap(([path, node]) => ["required", "enum", "format"].filter((k) => k in node).map((k) => `${path}|${k}|${JSON.stringify(node[k])}`));

    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const tool of AGENT_TOOLS) {
      const text = JSON.stringify(tool.inputSchema);
      for (const limit of ["minimum", "maximum", "minLength", "maxLength"]) expect(text, `${tool.name}: ${limit}`).not.toContain(limit);
      for (const [path, node] of walk(tool.inputSchema)) {
        if (node["type"] === "object") expect(node["additionalProperties"], `${tool.name} ${path}`).toBe(false);
      }
      expect(kept(tool.inputSchema)).toEqual(kept(AGENT_INPUT_SCHEMAS[tool.name]));
      expect(tool.inputSchema).toEqual(strictSchema(AGENT_INPUT_SCHEMAS[tool.name]));
    }
    const hold = AGENT_TOOLS.find((t) => t.name === "hold")?.inputSchema as Node;
    expect(kept(hold)).toContain('|required|["party_size","starts_at","duration_minutes","assignment"]');
    expect(kept(hold)).toContain('assignment.kind|enum|["unit","combo"]');
    expect(kept(hold)).toContain('starts_at|format|"date-time"');

    for (const tool of AGENT_TOOLS) {
      const definition = TOOLS.find((t) => t.name === tool.name);
      expect(tool.description).toBe(definition?.description);
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }

    expect(INPUT_SCHEMAS).toEqual(before);
    expect(AGENT_INPUT_SCHEMAS).toEqual(agentBefore);
  });

  it("strictSchema drops a limit only where it is a keyword, not where it is a property's name", () => {
    expect(strictSchema({ type: "object", properties: { minimum: { type: "integer", minimum: 1, maximum: 9 } }, required: ["minimum"] })).toEqual({
      type: "object",
      properties: { minimum: { type: "integer" } },
      required: ["minimum"],
      additionalProperties: false,
    });
  });
});

describe("validateArgs", () => {
  const hold = AGENT_INPUT_SCHEMAS.hold;
  const cancel = AGENT_INPUT_SCHEMAS.cancel;

  it("accepts a valid call and names the first problem otherwise", () => {
    expect(validateArgs(hold, HOLD)).toBeNull();
    expect(validateArgs(hold, { ...HOLD, starts_at: "2064-01-07T19:00:00+05:00" })).toBeNull();
    expect(validateArgs(hold, { ...HOLD, starts_at: "2064-01-07T19:00:00.250Z" })).toBeNull();
    expect(validateArgs(cancel, { reservation_id: UUID, reason: "plans changed", expected_version: 3 })).toBeNull();

    expect(validateArgs(hold, { ...HOLD, party_size: 0 })).toBe("party_size: must be at least 1");
    expect(validateArgs(hold, { ...HOLD, party_size: 2.5 })).toBe("party_size: must be an integer");
    expect(validateArgs(hold, { ...HOLD, party_size: "2" })).toBe("party_size: must be an integer");
    expect(validateArgs(hold, { ...HOLD, party_size: 10_001 })).toBe("party_size: must be at most 10000");
    expect(validateArgs(hold, { ...HOLD, starts_at: "tomorrow" })).toBe("starts_at: must be a date-time");
    expect(validateArgs(hold, { ...HOLD, starts_at: 5 })).toBe("starts_at: must be a string");
    expect(validateArgs(hold, { ...HOLD, assignment: { kind: "booth", id: UUID } })).toBe("assignment.kind: must be one of unit, combo");
    expect(validateArgs(hold, { ...HOLD, assignment: { kind: "unit", id: "x" } })).toBe("assignment.id: must be a uuid");
    expect(validateArgs(hold, { ...HOLD, assignment: "unit" })).toBe("assignment: must be an object");
    expect(validateArgs(hold, { ...HOLD, assignment: { kind: "unit" } })).toBe("assignment.id: is required");
    expect(validateArgs(hold, { ...HOLD, external_ref: "x" })).toBe("external_ref: is not allowed");
    expect(validateArgs(hold, null)).toBe("(input): must be an object");
    expect(validateArgs(hold, [])).toBe("(input): must be an object");

    const withoutDuration = Object.fromEntries(Object.entries(HOLD).filter(([name]) => name !== "duration_minutes"));
    expect(validateArgs(hold, withoutDuration)).toBe("duration_minutes: is required");

    expect(validateArgs(cancel, { reservation_id: UUID, reason: "" })).toBe("reason: must be at least 1 characters long");
    expect(validateArgs(cancel, { reservation_id: UUID, reason: "a".repeat(500) })).toBeNull();
    expect(validateArgs(cancel, { reservation_id: UUID, reason: "a".repeat(501) })).toBe("reason: must be at most 500 characters long");
  });

  it("holds a date-time to RFC 3339: an offset or Z is required and the date must exist", () => {
    for (const bad of ["2064-01-07T19:00:00", "2064-01-07 19:00:00Z", "2064-01-07", "2064-02-30T10:00:00Z", "2064-13-01T10:00:00Z", "2064-01-07T24:00:00Z", "2064-01-07T10:00:00+25:00"]) {
      expect(validateArgs(hold, { ...HOLD, starts_at: bad }), bad).toBe("starts_at: must be a date-time");
    }
    expect(validateArgs(hold, { ...HOLD, starts_at: "2064-02-29T10:00:00Z" })).toBeNull();
    expect(validateArgs(hold, { ...HOLD, starts_at: "2063-02-29T10:00:00Z" })).toBe("starts_at: must be a date-time");
  });

  it("refuses to judge a schema type it does not know", () => {
    expect(() => validateArgs({ type: "boolean" }, true)).toThrow(/boolean/);
  });
});
