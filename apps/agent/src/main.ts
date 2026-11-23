import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createDastarClient } from "@dastar/client";
import { createDastar } from "@dastar/db";
import { createAnthropicProvider } from "./anthropic.js";
import { createAgentApp } from "./app.js";
import { readAgentConfig } from "./config.js";
import { loadPrompt } from "./prompt.js";
import { checkStartup } from "./startup.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One JSON line on stderr; an error is reported by its message alone. */
function logError(msg: string, error: unknown): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg, error: messageOf(error) })}\n`);
}

/** Where the server listens, once it has bound. */
type Bound = { server: ReturnType<typeof serve>; host: string; port: number };

async function main(): Promise<void> {
  const configured = readAgentConfig(process.env);
  if (!configured.ok) {
    process.stderr.write(`dastar-agent: ${configured.line}\n`);
    process.exit(1);
  }
  const { config } = configured;

  // pg-pool requires a listener for an idle client's error, or the process dies with it
  const pool = new Pool({ connectionString: config.databaseUrl, application_name: "dastar-agent" });
  pool.on("error", (error) => {
    logError("pool error", error);
  });
  const dastar = createDastar({ pool, cancellerConnectionString: config.databaseUrl });
  const release = async (): Promise<void> => {
    try {
      await dastar.close();
    } finally {
      await pool.end();
    }
  };
  /** Writes the refusal, lets go of the database and exits; a failure to let go does not change the exit. */
  const refuse = async (line: string): Promise<never> => {
    process.stderr.write(`dastar-agent: ${line}\n`);
    await release().catch(() => undefined);
    return process.exit(1);
  };

  let fetchApp: (request: Request) => Response | Promise<Response>;
  try {
    const checked = await checkStartup({ config, dastar });
    if (!checked.ok) return await refuse(checked.line);
    const app = createAgentApp({
      dastar,
      provider: createAnthropicProvider({ apiKey: config.anthropicApiKey, model: config.model, effort: config.effort }),
      agentClient: (sessionId) => createDastarClient({ baseUrl: config.dastarUrl, key: config.agentKey, session: sessionId }),
      demoClient: createDastarClient({ baseUrl: config.dastarUrl, key: config.demoConfirmKey }),
      venue: checked.venue,
      agentKeyId: config.agentKeyId,
      tokenKey: config.tokenKey,
      prompt: loadPrompt(),
    });
    fetchApp = app.fetch;
  } catch (error) {
    return await refuse(`could not start: ${messageOf(error)}`);
  }

  let bound: Bound;
  try {
    bound = await new Promise<Bound>((resolve, reject) => {
      const s = serve({ fetch: fetchApp, port: config.port, hostname: config.host }, (info) => {
        s.off("error", reject);
        // once bound, a later server-level error (EMFILE, a socket error) is logged rather than left with no listener
        s.on("error", (error) => {
          logError("server error", error);
        });
        resolve({ server: s, host: info.address, port: info.port });
      });
      s.once("error", reject);
    });
  } catch (error) {
    // a port taken or an address that is not the host's own is a refusal, not a crash
    return await refuse(messageOf(error));
  }

  const { server, host, port } = bound;
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "listening", host, port }));

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await release();
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        logError("shutdown failed", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
