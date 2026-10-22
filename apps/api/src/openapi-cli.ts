import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiText } from "./openapi.js";

// writes the committed contract; a test fails while it differs from what the routes generate
const target = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(target, openApiText());
console.log(`wrote ${target}`);
