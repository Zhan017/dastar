import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SCHEMA, generateSchema, readDocument } from "../scripts/generate.js";

describe("src/schema.ts", () => {
  it("is generated from the committed document", async () => {
    expect(readFileSync(SCHEMA, "utf8"), "run pnpm openapi").toBe(await generateSchema(readDocument()));
  });
});
