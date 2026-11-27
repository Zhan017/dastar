import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createDastar, type Dastar } from "@dastar/db";
import { createAnthropicProvider } from "../anthropic.js";
import type { Usage } from "../provider.js";
import { loadAccuracy } from "./accuracy.js";
import { readJudgeConfig, type JudgeConfig } from "./config.js";
import { judgeOnce, startJudge, type BatchOutcome } from "./loop.js";
import { loadJudgePrompt } from "./prompt.js";
import { newPace, type JudgeDeps } from "./turn.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const REDACTED = "[redacted]";

/** The password of a connection URL as written in it and as decoded; empty when the URL has none or is not a URL. */
function passwordsOf(databaseUrl: string): string[] {
  let password: string;
  try {
    password = new URL(databaseUrl).password;
  } catch {
    return [];
  }
  let decoded = password;
  try {
    decoded = decodeURIComponent(password);
  } catch {
    // a password that is not valid percent-encoding is kept as written
  }
  return [password, decoded];
}

/** What a log line must never carry: the connection URL, its password and the model key. Absent and empty values are left out. */
export function secretsOf(databaseUrl: string | undefined, apiKey: string | undefined): string[] {
  const secrets = [...(databaseUrl === undefined ? [] : [databaseUrl, ...passwordsOf(databaseUrl)]), ...(apiKey === undefined ? [] : [apiKey])];
  return secrets.filter((secret) => secret !== "");
}

/** The text with each occurrence of each secret replaced; the longest first, so a URL goes whole before its password does. */
export function redact(text: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.replaceAll(secret, REDACTED), text);
}

/** One JSON line on stderr; an error is reported by its message alone, with the secrets taken out. */
function logError(msg: string, error: unknown, secrets: readonly string[]): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg, error: redact(messageOf(error), secrets) })}\n`);
}

/** One JSON line on stdout. */
function logInfo(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }));
}

/** Writes the refusal on stderr and gives the exit code of a process that did not start or did not finish. */
function refuse(line: string): number {
  process.stderr.write(`dastar-judge: ${line}\n`);
  return 1;
}

const tokens = (usage: Usage): Record<string, number> => ({
  input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite,
});

const counts = (b: BatchOutcome): Record<string, unknown> => ({
  size: b.size, judged: b.judged, failed: b.failed, discarded: b.discarded, retried: b.retried, capped: b.capped, tokens: tokens(b.usage),
  ...(b.pauseMs !== undefined ? { pause_ms: b.pauseMs } : {}),
});

/** The judge's connection pool, named as the judge's own, with the listener pg-pool requires for an idle client's error (or the process dies with it). */
export function openJudgePool(config: JudgeConfig, secrets: readonly string[]): Pool {
  const pool = new Pool({ connectionString: config.databaseUrl, application_name: "dastar-judge" });
  pool.on("error", (error) => {
    logError("pool error", error, secrets);
  });
  return pool;
}

/** What the judge judges with: the prompt, the accuracy entries and a provider that does not retry, over the given handle. */
export function judgeDepsOf(config: JudgeConfig, dastar: Dastar): JudgeDeps {
  // no retries in the SDK: each request the judge sends is one call counted against the day, and the three failures of a turn are three requests
  const provider = createAnthropicProvider({ apiKey: config.anthropicApiKey, model: config.model, effort: config.effort, maxRetries: 0 });
  return {
    dastar, provider, prompt: loadJudgePrompt(), model: config.model, effort: config.effort, accuracy: loadAccuracy(), dailyCalls: config.dailyCalls,
    transient: new Map(), pace: newPace(),
  };
}

/**
 * What the loop writes for each batch. A batch that judged, failed, discarded or retried something is a `batch` line; one
 * that did none of them is not, so a tick with nothing due, or with the day's calls used up, writes nothing. The day's calls
 * running out is one `capped` line, and the next only after a batch has done something since.
 */
export function batchLogger(log: (msg: string, fields: Record<string, unknown>) => void): (batch: BatchOutcome) => void {
  let capped = false;
  return (batch) => {
    if (batch.judged + batch.failed + batch.discarded + batch.retried > 0) {
      capped = false;
      log("batch", counts(batch));
    }
    if (batch.capped && !capped) {
      capped = true;
      log("capped", { due: batch.size });
    }
  };
}

/**
 * Runs the judge: `--once` judges what is due and returns; with no argument it judges on a loop until SIGINT or SIGTERM.
 * Returns the exit code: 0, or 1 for a refusal to start (settings, the database role) and for a provider that refuses the key.
 */
export async function main(args: string[], env: Record<string, string | undefined>): Promise<number> {
  const extra = args.find((arg) => arg !== "--once");
  if (extra !== undefined) return refuse(`unknown argument ${extra}; the only option is --once`);
  const configured = readJudgeConfig(env);
  if (!configured.ok) return refuse(configured.line);
  const { config } = configured;
  const secrets = secretsOf(config.databaseUrl, config.anthropicApiKey);
  const once = args.includes("--once");

  const pool = openJudgePool(config, secrets);
  const dastar = createDastar({ pool });
  try {
    if (!(await dastar.judge.canJudge())) return refuse("the database user cannot update dastar_agent.turn.judge_result; connect as dastar_judge");

    const deps = judgeDepsOf(config, dastar);
    logInfo("judging", {
      mode: once ? "once" : "loop", model: config.model, effort: config.effort,
      every_ms: config.everyMs, limit: config.limit, daily_calls: config.dailyCalls, prompt_hash: deps.prompt.hash,
    });

    if (once) {
      const total = await judgeOnce(deps, config.limit);
      logInfo("judged", counts(total));
      return total.fatal === undefined ? 0 : refuse(total.fatal);
    }

    const running = startJudge(deps, { everyMs: config.everyMs, limit: config.limit, drain: true }, {
      onBatch: batchLogger(logInfo),
      onError: (error) => {
        logError("judge tick failed", error, secrets);
      },
    });
    const stop = (): void => {
      void running.stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await running.finished;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return running.stats.fatal === undefined ? 0 : refuse(running.stats.fatal);
  } catch (error) {
    logError("the judge stopped", error, secrets);
    return 1;
  } finally {
    await dastar.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    logError("the judge stopped", error, secretsOf(process.env["DATABASE_URL"]?.trim(), process.env["ANTHROPIC_API_KEY"]?.trim()));
    process.exitCode = 1;
  }
}
