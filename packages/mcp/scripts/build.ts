import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Where the one-file server lands. */
export const BUNDLE = fileURLToPath(new URL("../dist/dastar-mcp.js", import.meta.url));

/** Bundles the server and the workspace packages into one file; the SDK and openapi-fetch stay imports for the install to supply. */
export async function buildBundle(): Promise<void> {
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: BUNDLE,
    banner: { js: "#!/usr/bin/env node" },
    external: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/*", "openapi-fetch"],
    logLevel: "warning",
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildBundle();
  process.stdout.write(`wrote ${BUNDLE}\n`);
}
