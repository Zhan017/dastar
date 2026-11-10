import { readFileSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDastarClient } from "@dastar/client";
import { createToolSession } from "@dastar/agent-tools";
import { readConfig } from "./config.js";
import { createServer } from "./server.js";
import { checkCredential } from "./startup.js";

/** The package's own version, which the server reports to clients; the path holds from `src/` and from `dist/`. */
function readVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
  return typeof version === "string" ? version : "0.0.0";
}

/** Says why the server will not start, on stderr only, and exits 1 once the line is written. */
function refuse(line: string): void {
  process.stderr.write(`dastar-mcp: ${line}\n`, () => process.exit(1));
}

const configured = readConfig(process.env);
if (!configured.ok) {
  refuse(configured.line);
} else {
  const { url, key, venueId } = configured.config;
  const client = createDastarClient({ baseUrl: url, key });
  const refusal = await checkCredential(client, { url, venueId });
  if (refusal !== null) {
    refuse(refusal);
  } else {
    const version = readVersion();
    const session = createToolSession({ client, venueId });
    await serveStdio(() => createServer(session, version), {
      onerror: (e) => { process.stderr.write(`dastar-mcp: ${e.message}\n`); },
    });
  }
}
