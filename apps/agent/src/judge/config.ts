import { EFFORTS, type Effort } from "../config.js";

export type JudgeConfig = {
  /** The connection of the judge's own database role. */
  databaseUrl: string;
  anthropicApiKey: string;
  model: string;
  effort: Effort;
  /** The pause between the judge's passes. */
  everyMs: number;
  /** The most turns one pass judges. */
  limit: number;
  /** The most provider calls a UTC day may hold. */
  dailyCalls: number;
};

export type JudgeConfigResult = { ok: true; config: JudgeConfig } | { ok: false; line: string };

const SETTINGS = ["DATABASE_URL", "ANTHROPIC_API_KEY"] as const;
const COUNTS = ["JUDGE_EVERY_MS", "JUDGE_LIMIT", "JUDGE_DAILY_CALLS"] as const;

/** A key travels in a header, and the runtime's error for a bad header value quotes the value; a key of visible ASCII cannot cause one. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_EFFORT: Effort = "medium";
const DEFAULT_EVERY_MS = 10_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_DAILY_CALLS = 500;

const refuse = (line: string): { ok: false; line: string } => ({ ok: false, line });

const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

/** What the judge needs to ask the model, with no database: the key, the model and the effort. */
export type JudgeModelSettings = { anthropicApiKey: string; model: string; effort: Effort };

export type JudgeModelResult = { ok: true; settings: JudgeModelSettings } | { ok: false; line: string };

/** Reads ANTHROPIC_API_KEY (required, visible ASCII only), JUDGE_MODEL and JUDGE_EFFORT from the environment, refusing with one line that names what to fix. */
export function readJudgeModel(env: Record<string, string | undefined>): JudgeModelResult {
  const read = (name: string): string => (env[name] ?? "").trim();

  const anthropicApiKey = read("ANTHROPIC_API_KEY");
  if (anthropicApiKey === "") return refuse("set ANTHROPIC_API_KEY");
  if (!VISIBLE_ASCII.test(anthropicApiKey)) return refuse("ANTHROPIC_API_KEY must contain only visible ASCII characters");

  const effort = read("JUDGE_EFFORT") || DEFAULT_EFFORT;
  if (!isEffort(effort)) return refuse(`JUDGE_EFFORT must be one of ${EFFORTS.join(", ")}`);

  return { ok: true, settings: { anthropicApiKey, model: read("JUDGE_MODEL") || DEFAULT_MODEL, effort } };
}

/** Reads the judge's two required settings and its optional ones (JUDGE_MODEL, JUDGE_EFFORT, JUDGE_EVERY_MS, JUDGE_LIMIT, JUDGE_DAILY_CALLS) from the environment, refusing with one line that names what to fix. */
export function readJudgeConfig(env: Record<string, string | undefined>): JudgeConfigResult {
  const read = (name: string): string => (env[name] ?? "").trim();

  const missing = SETTINGS.filter((name) => read(name) === "");
  if (missing.length > 0) return refuse(`set DATABASE_URL and ANTHROPIC_API_KEY; missing: ${missing.join(", ")}`);

  const asked = readJudgeModel(env);
  if (!asked.ok) return asked;
  const { anthropicApiKey, model, effort } = asked.settings;

  const values: Record<(typeof COUNTS)[number], number> = { JUDGE_EVERY_MS: DEFAULT_EVERY_MS, JUDGE_LIMIT: DEFAULT_LIMIT, JUDGE_DAILY_CALLS: DEFAULT_DAILY_CALLS };
  for (const name of COUNTS) {
    const text = read(name);
    if (text === "") continue;
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < 1) return refuse(`${name} must be a positive integer`);
    values[name] = value;
  }

  return {
    ok: true,
    config: {
      databaseUrl: read("DATABASE_URL"),
      anthropicApiKey,
      model,
      effort,
      everyMs: values.JUDGE_EVERY_MS,
      limit: values.JUDGE_LIMIT,
      dailyCalls: values.JUDGE_DAILY_CALLS,
    },
  };
}
