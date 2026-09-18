import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "@hono/zod-openapi";
import { Pool } from "pg";
import { createKey, type Capability } from "./auth.js";

const CAPABILITIES: readonly Capability[] = ["hold", "confirm", "cancel", "read"];

/** Creates one key and returns it. The presented key is shown once; the table keeps only its hash. */
export async function runKeysCli(argv: string[], env: Record<string, string | undefined>): Promise<{ id: string; key: string }> {
  const { values } = parseArgs({ args: argv, options: { label: { type: "string" }, capabilities: { type: "string" }, venues: { type: "string" } } });
  if (!values.label) throw new Error("--label is required");
  if (!values.capabilities) throw new Error("--capabilities is required, a comma-separated list of: " + CAPABILITIES.join(", "));
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const capabilities = values.capabilities.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const c of capabilities) if (!(CAPABILITIES as readonly string[]).includes(c)) throw new Error(`unknown capability "${c}"`);
  const venueIds = values.venues === undefined ? null : values.venues.split(",").map((s) => z.guid().parse(s.trim()).toLowerCase());
  const pool = new Pool({ connectionString: url, max: 1 });
  pool.on("error", () => undefined);
  try {
    return await createKey(pool, { label: values.label, capabilities, venueIds });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const created = await runKeysCli(process.argv.slice(2), process.env);
    console.log(JSON.stringify(created));
    console.error("Store the key now; only its hash is kept.");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
