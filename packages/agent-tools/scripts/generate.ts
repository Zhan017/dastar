import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DOCUMENT = fileURLToPath(new URL("../../../apps/api/openapi.json", import.meta.url));
export const INPUTS = fileURLToPath(new URL("../src/inputs.ts", import.meta.url));

type Schema = { [keyword: string]: unknown; properties?: Record<string, unknown>; required?: string[] };

/** The part of the committed OpenAPI document the tool inputs are taken from. */
export type OpenApiDocument = {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string; schema: Schema }[] } | undefined> | undefined>;
  components: { schemas: Record<string, Schema | undefined> };
};

const HEADER = "// Generated from apps/api/openapi.json by `pnpm --filter @dastar/agent-tools generate`. Do not edit.\n\n";
const DOC = "/** Each tool's input: the API's request schema, taken unchanged from the committed document. */\n";

/** The reservation routes take the id in the path; a tool takes it as an argument. */
const ID_ROUTE = "/v1/reservations/{id}/cancel";

function schemaOf(document: OpenApiDocument, name: string): Schema {
  const schema = document.components.schemas[name];
  if (schema === undefined) throw new Error(`the document has no ${name} schema`);
  return schema;
}

function reservationId(document: OpenApiDocument): Schema {
  const parameter = document.paths[ID_ROUTE]?.["post"]?.parameters?.find((p) => p.name === "id" && p.in === "path");
  if (parameter === undefined) throw new Error(`the document has no id path parameter on post ${ID_ROUTE}`);
  return parameter.schema;
}

/** A tool input leaves the document, so it cannot point back into it, and JSON Schema has no `nullable`. */
function assertStandsAlone(tool: string, node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertStandsAlone(tool, item);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" || key === "nullable") {
        throw new Error(`input of ${tool} uses ${key}; a tool input must stand alone as JSON Schema`);
      }
      assertStandsAlone(tool, value);
    }
  }
}

/**
 * The text of src/inputs.ts for a document: each tool's input, behind a header that names the command. Search and hold take the
 * API's request schemas as they are; cancel and get_reservation add the reservation id the API reads from the path.
 */
export function generateInputs(document: OpenApiDocument): string {
  const id = reservationId(document);
  const cancel = schemaOf(document, "CancelRequest");
  const inputs = {
    search_availability: schemaOf(document, "AvailabilityRequest"),
    hold: schemaOf(document, "HoldRequest"),
    cancel: {
      type: "object",
      properties: { reservation_id: id, ...cancel.properties },
      required: ["reservation_id", ...(cancel.required ?? [])],
    },
    get_reservation: { type: "object", properties: { reservation_id: id }, required: ["reservation_id"] },
  };
  for (const [tool, input] of Object.entries(inputs)) assertStandsAlone(tool, input);
  return `${HEADER}${DOC}export const INPUT_SCHEMAS = ${JSON.stringify(inputs, null, 2)} as const;\n`;
}

export function readDocument(): OpenApiDocument {
  return JSON.parse(readFileSync(DOCUMENT, "utf8")) as OpenApiDocument;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(INPUTS, generateInputs(readDocument()));
  console.log(`wrote ${INPUTS}`);
}
