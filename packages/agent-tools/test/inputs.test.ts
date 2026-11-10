import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { INPUTS, generateInputs, readDocument } from "../scripts/generate.js";
import { INPUT_SCHEMAS } from "../src/inputs.js";

describe("src/inputs.ts", () => {
  it("is generated from the committed document", () => {
    expect(readFileSync(INPUTS, "utf8"), "run pnpm openapi").toBe(generateInputs(readDocument()));
  });

  it("takes each tool's input from the document's request schemas and the reservation id parameter", () => {
    const doc = readDocument();
    const s = doc.components.schemas;
    const id = doc.paths["/v1/reservations/{id}/cancel"]!["post"]!.parameters!.find((p) => p.name === "id")!.schema;
    expect(INPUT_SCHEMAS.search_availability).toEqual(s.AvailabilityRequest);
    expect(INPUT_SCHEMAS.hold).toEqual(s.HoldRequest);
    expect(INPUT_SCHEMAS.cancel).toEqual({
      type: "object",
      properties: { reservation_id: id, ...s.CancelRequest!.properties },
      required: ["reservation_id", ...s.CancelRequest!.required!],
    });
    expect(INPUT_SCHEMAS.get_reservation).toEqual({ type: "object", properties: { reservation_id: id }, required: ["reservation_id"] });
  });

  it("refuses a schema that would not stand alone as JSON Schema", () => {
    const withRef = readDocument();
    withRef.components.schemas.HoldRequest!.properties!.assignment = { $ref: "#/components/schemas/Assignment" };
    expect(() => generateInputs(withRef)).toThrow(/input of hold uses \$ref/);
    const withNullable = readDocument();
    withNullable.components.schemas.CancelRequest!.properties!.reason = { type: "string", nullable: true };
    expect(() => generateInputs(withNullable)).toThrow(/input of cancel uses nullable/);
  });
});
