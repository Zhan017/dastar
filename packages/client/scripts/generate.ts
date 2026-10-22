import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

export const DOCUMENT = fileURLToPath(new URL("../../../apps/api/openapi.json", import.meta.url));
export const SCHEMA = fileURLToPath(new URL("../src/schema.ts", import.meta.url));

const HEADER = "// Generated from apps/api/openapi.json by `pnpm --filter @dastar/client generate`. Do not edit.\n\n";

/**
 * The text of src/schema.ts for a document: openapi-typescript's types behind a header that names the command. A field with a
 * default stays optional, as the document's required lists say; by default openapi-typescript would make it required.
 */
export async function generateSchema(document: OpenAPI3): Promise<string> {
  return HEADER + astToString(await openapiTS(document, { silent: true, defaultNonNullable: false }));
}

export function readDocument(): OpenAPI3 {
  return JSON.parse(readFileSync(DOCUMENT, "utf8")) as OpenAPI3;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(SCHEMA, await generateSchema(readDocument()));
  console.log(`wrote ${SCHEMA}`);
}
