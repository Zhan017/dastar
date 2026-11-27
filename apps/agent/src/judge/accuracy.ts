import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JudgeAccuracy } from "@dastar/db";

export const ACCURACY_FILE: string = fileURLToPath(new URL("../../judge/accuracy.json", import.meta.url));

/** One measurement of a judge (a model, an effort and a prompt) against a labeled set: how well it finds the statements, over all and over the undeclared ones. */
export type AccuracyEntry = JudgeAccuracy & { model: string; effort: string; prompt_hash: string; measured_at: string; items: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isRate = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));

function isInterval(value: unknown): boolean {
  return isRecord(value) && isRate(value["value"]) && isRate(value["low"]) && isRate(value["high"]) && isCount(value["k"]) && isCount(value["n"]);
}

function isRates(value: unknown): boolean {
  return isRecord(value) && isInterval(value["precision"]) && isInterval(value["recall"]);
}

function isEntry(value: unknown): value is AccuracyEntry {
  if (!isRecord(value)) return false;
  return ["model", "effort", "prompt_hash", "measured_at", "run", "labeled_set"].every((key) => typeof value[key] === "string")
    && isCount(value["items"]) && isRates(value["undeclared"]) && isRates(value["all"]);
}

/** The measurements in the file: a list of entries, empty until a judge has been measured. Throws for a file that is not that. */
export function loadAccuracy(file: string = ACCURACY_FILE): AccuracyEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`the accuracy file ${file} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`the accuracy file ${file} must be a list of entries`);
  const entries = parsed as unknown[];
  const bad = entries.findIndex((entry) => !isEntry(entry));
  if (bad >= 0) throw new Error(`entry ${bad} of the accuracy file ${file} is not a measurement`);
  // a read takes the first entry of a key, so a later one under the same key would never be read: it is refused, not shadowed
  const seen = new Map<string, number>();
  for (const [i, entry] of (entries as AccuracyEntry[]).entries()) {
    const key = JSON.stringify([entry.model, entry.effort, entry.prompt_hash]);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `entries ${first} and ${i} of the accuracy file ${file} share the model ${entry.model}, the effort ${entry.effort} and the prompt hash ${entry.prompt_hash}; replace the earlier one`,
      );
    }
    seen.set(key, i);
  }
  return entries as AccuracyEntry[];
}

/** The accuracy of the entry measured for exactly this model, effort and prompt hash, or null when none was. */
export function stampFor(entries: readonly AccuracyEntry[], key: { model: string; effort: string; prompt_hash: string }): JudgeAccuracy | null {
  const entry = entries.find((e) => e.model === key.model && e.effort === key.effort && e.prompt_hash === key.prompt_hash);
  if (entry === undefined) return null;
  return structuredClone({ run: entry.run, labeled_set: entry.labeled_set, undeclared: entry.undeclared, all: entry.all });
}
