import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Interval, Rates } from "@dastar/db";
import { ACCURACY_FILE, loadAccuracy, stampFor, type AccuracyEntry } from "../src/judge/accuracy.js";

const interval = (value: number, k: number, n: number): Interval => ({ value, low: value - 0.1, high: Math.min(1, value + 0.1), k, n });
const rates = (precision: number, recall: number): Rates => ({ precision: interval(precision, 9, 10), recall: interval(recall, 8, 10) });

const ENTRY: AccuracyEntry = {
  run: "2064-02-01-a", labeled_set: "statements-v1", undeclared: rates(0.9, 0.8), all: rates(0.95, 0.85),
  model: "claude-opus-5-5", effort: "medium", prompt_hash: "ab12cd34", measured_at: "2064-02-01T10:00:00Z", items: 40,
};
const KEY = { model: ENTRY.model, effort: ENTRY.effort, prompt_hash: ENTRY.prompt_hash };

describe("stampFor", () => {
  it("copies the entry whose model, effort and prompt hash all match", () => {
    const other: AccuracyEntry = { ...ENTRY, run: "2064-02-02-b", model: "claude-sonnet-5-5", undeclared: rates(0.5, 0.5) };
    const stamp = stampFor([other, ENTRY], KEY);
    expect(stamp).toEqual({ run: ENTRY.run, labeled_set: ENTRY.labeled_set, undeclared: ENTRY.undeclared, all: ENTRY.all });
    // a copy: changing it leaves the entry as it was
    stamp!.undeclared.precision.k = 0;
    expect(ENTRY.undeclared.precision.k).toBe(9);
  });

  it("is null when the model, the effort or the prompt hash differs, or there are no entries", () => {
    expect(stampFor([ENTRY], { ...KEY, model: "claude-sonnet-5-5" })).toBeNull();
    expect(stampFor([ENTRY], { ...KEY, effort: "high" })).toBeNull();
    expect(stampFor([ENTRY], { ...KEY, prompt_hash: "00000000" })).toBeNull();
    expect(stampFor([], KEY)).toBeNull();
  });
});

describe("loadAccuracy", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-accuracy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fileWith = (name: string, text: string): string => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  };

  it("loads the committed accuracy.json as an empty list", () => {
    expect(loadAccuracy()).toEqual([]);
    expect(loadAccuracy(ACCURACY_FILE)).toEqual([]);
  });

  it("loads a list of entries as written", () => {
    expect(loadAccuracy(fileWith("entries.json", JSON.stringify([ENTRY])))).toEqual([ENTRY]);
  });

  it("refuses a file that is not a list of entries", () => {
    expect(() => loadAccuracy(join(dir, "missing.json"))).toThrow(/cannot be read/);
    expect(() => loadAccuracy(fileWith("broken.json", "[{"))).toThrow(/cannot be read/);
    expect(() => loadAccuracy(fileWith("object.json", "{}"))).toThrow(/must be a list of entries/);
    expect(() => loadAccuracy(fileWith("number.json", "1"))).toThrow(/must be a list of entries/);
    expect(() => loadAccuracy(fileWith("empty-entry.json", "[{}]"))).toThrow(/entry 0 .* is not a measurement/);
    const noItems = Object.fromEntries(Object.entries(ENTRY).filter(([key]) => key !== "items"));
    expect(() => loadAccuracy(fileWith("no-items.json", JSON.stringify([ENTRY, noItems])))).toThrow(/entry 1 .* is not a measurement/);
    expect(() => loadAccuracy(fileWith("bad-rates.json", JSON.stringify([{ ...ENTRY, all: { precision: interval(1, 1, 1) } }])))).toThrow(/entry 0 .* is not a measurement/);
    expect(() => loadAccuracy(fileWith("bad-model.json", JSON.stringify([{ ...ENTRY, model: 7 }])))).toThrow(/entry 0 .* is not a measurement/);
  });
});
