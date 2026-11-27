import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { JudgeStatement } from "@dastar/db";
import { runJudgeMode } from "../scripts/live.js";
import { loadLabeled, type LabeledItem } from "../src/judge/labeled.js";
import { PRICES_PER_MTOK, measure, predict, wilson, type Prediction } from "../src/judge/measure.js";
import { JUDGE_REPLY_SCHEMA, judgeRequest, loadJudgePrompt } from "../src/judge/prompt.js";
import { MAX_TEXT_CHARS } from "../src/judge/turn.js";
import type { Completion } from "../src/provider.js";
import { USAGE, replyWith, scripted, type Step } from "./fake-provider.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/judge-labeled.json", import.meta.url));
const RESERVATION_A = "0199a000-0000-7000-8000-0000000000a1";
const RESERVATION_B = "0199a000-0000-7000-8000-0000000000a2";
const MODEL = "claude-opus-5-5";

const prompt = loadJudgePrompt();

const statement = (over: Partial<JudgeStatement> & { quote: string }): JudgeStatement => ({ reservation_id: null, status: "held", starts_at: null, party_size: null, ...over });

/** The model's reply listing these statements, answered by a model that has a price. */
const answer = (...statements: JudgeStatement[]): Completion => ({ ...replyWith(JSON.stringify({ statements })), model: MODEL });
const refusal: Completion = { kind: "refused", usage: { ...USAGE }, model: MODEL };

const withStatus = (status: number): Error => Object.assign(new Error("x"), { status });
const failing = (status?: number): Step => () => {
  throw status === undefined ? new Error("connection reset") : withStatus(status);
};

/** What a judge that reads the fixture's two items as the labels do, apart from two differences: item a's start is written in UTC, and item b's first statement leaves its start out and its second reads "cancelled" as "held". */
const FIXTURE_ANSWERS = (): Completion[] => [
  answer(statement({ quote: "a table for 2 held for you on 7 January at 19:00", reservation_id: RESERVATION_A, status: "held", starts_at: "2064-01-07T14:00:00Z", party_size: 2 })),
  answer(
    statement({ quote: "Your table for 4 on 8 January at 20:00 is confirmed", reservation_id: RESERVATION_B, status: "confirmed", party_size: 4 }),
    statement({ quote: "I have also cancelled your earlier booking", status: "held" }),
  ),
];

const fixtureItems = (): LabeledItem[] => loadLabeled(FIXTURE).items;

/** A third item whose call is refused: the first item's text and labels, from two passes that disagreed. */
const refusedItem = (): LabeledItem => ({ ...fixtureItems()[0]!, id: "c", labeled_by: "two-pass", disagreed: true });

async function predictAll(items: readonly LabeledItem[], steps: Step[]): Promise<{ predictions: Prediction[]; requests: ReturnType<typeof scripted>["requests"] }> {
  const provider = scripted(...steps);
  const predictions: Prediction[] = [];
  for (const item of items) predictions.push(await predict(provider, prompt, item));
  return { predictions, requests: provider.requests };
}

describe("wilson", () => {
  it("gives nulls for no trials and the 95% score interval otherwise", () => {
    expect(wilson(0, 0)).toEqual({ value: null, low: null, high: null, k: 0, n: 0 });

    const half = wilson(5, 10);
    expect(half.value).toBe(0.5);
    expect(half.low).toBeCloseTo(0.2366, 4);
    expect(half.high).toBeCloseTo(0.7634, 4);
    expect([half.k, half.n]).toEqual([5, 10]);

    const all = wilson(10, 10);
    expect(all.value).toBe(1);
    expect(all.low).toBeCloseTo(0.7225, 4);
    expect(all.high).toBe(1);

    const none = wilson(0, 10);
    expect(none.value).toBe(0);
    expect(none.low).toBeCloseTo(0, 10);
    expect(none.high).toBeCloseTo(0.2775, 4);
  });
});

describe("measures the fixture with a scripted provider", () => {
  it("counts matches, field agreement, tokens and cost, and keeps a refused item out of every rate", async () => {
    const items = [...fixtureItems(), refusedItem()];
    const { predictions, requests } = await predictAll(items, [...FIXTURE_ANSWERS(), refusal]);

    // one call per item, with no tools, the judge's system prompt and reply schema, and the item's text in the message
    expect(requests).toHaveLength(3);
    for (const [i, request] of requests.entries()) {
      expect(request.tools).toEqual([]);
      expect(request.system).toBe(prompt.system);
      expect(request.replySchema).toEqual(JUDGE_REPLY_SCHEMA);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      const [message] = request.messages;
      expect(message?.role).toBe("user");
      expect(message?.role === "user" ? message.text : "").toContain(items[i]!.input.assistant_text);
    }

    expect(predictions[2]).toEqual({ item: "c", kept: [], dropped: 0, failed: "refused", model: MODEL, usage: USAGE });
    const report = measure(items, predictions);

    // item a: its one label is undeclared and its prediction matches it. Item b: the declared label matches; the undeclared
    // one is missed, and the prediction adds a statement no label has
    expect(report.items).toBe(2);
    expect(report.undeclared.precision).toEqual(wilson(1, 2));
    expect(report.undeclared.recall).toEqual(wilson(1, 2));
    expect(report.undeclared.precision).toMatchObject({ value: 0.5, k: 1, n: 2 });
    expect(report.undeclared.recall).toMatchObject({ value: 0.5, k: 1, n: 2 });
    expect(report.all.precision).toEqual(wilson(2, 3));
    expect(report.all.recall).toEqual(wilson(2, 3));
    expect(report.all.precision).toMatchObject({ k: 2, n: 3 });
    expect(report.all.recall).toMatchObject({ k: 2, n: 3 });

    // the two matched pairs: item a's start is the same instant in another offset, so it agrees; item b's label has a start the prediction left out
    expect(report.field_agreement).toEqual(wilson(1, 2));
    // the labeling passes are a property of the labels: both two-pass items count, the refused one too. Item b's passes agreed; item c's did not
    expect(report.label_agreement).toEqual(wilson(1, 2));
    expect(report.label_agreement).toMatchObject({ value: 0.5, k: 1, n: 2 });
    // and an item with no prediction at all counts as well
    expect(measure(items, []).label_agreement).toMatchObject({ k: 1, n: 2 });

    expect(report.failures).toEqual({ refused: 1 });
    expect(report.dropped).toBe(0);
    // three calls answered, the refused one included
    expect(report.usage).toEqual({ input: 300, output: 60, cacheRead: 30, cacheWrite: 15 });
    const price = PRICES_PER_MTOK[MODEL]!;
    expect(report.cost_usd).toBeCloseTo((300 * price.input + 60 * price.output + 30 * price.cacheRead + 15 * price.cacheWrite) / 1_000_000, 12);
    expect(report.cost_usd).toBeCloseTo(0.002481, 9);
  });

  it("prices only the models in the table, and leaves an item with no prediction out", async () => {
    const items = fixtureItems();
    const { predictions } = await predictAll(items, FIXTURE_ANSWERS());
    expect(PRICES_PER_MTOK).toEqual({ "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } });

    const elsewhere = predictions.map((p, i) => (i === 1 ? { ...p, model: "another-model" } : p));
    expect(measure(items, elsewhere).cost_usd).toBeNull();
    expect(measure(items, elsewhere).usage).toEqual({ input: 200, output: 40, cacheRead: 20, cacheWrite: 10 });

    const none = measure(items, []);
    expect(none.items).toBe(0);
    expect(none.cost_usd).toBe(0);
    expect(none.all.precision).toEqual(wilson(0, 0));
    expect(measure(items, [predictions[0]!]).items).toBe(1);
  });

  it("matches each label with the first prediction not yet taken, one to one, and the reservation as written in either case", () => {
    const item: LabeledItem = {
      ...fixtureItems()[0]!,
      labels: [statement({ quote: "held", reservation_id: RESERVATION_A }), statement({ quote: "held", reservation_id: RESERVATION_A })],
    };
    const kept = (reservation: string | null, status: "held" | "confirmed"): Prediction["kept"][number] => ({ quote: "held", claim: { reservation_id: reservation, status } });
    const one: Prediction = { item: item.id, kept: [kept(RESERVATION_A.toUpperCase(), "held"), kept(RESERVATION_A, "confirmed")], dropped: 0, model: null, usage: null };
    // two labels, one matching prediction: the second label finds none left
    expect(measure([item], [one]).all).toEqual({ precision: wilson(1, 2), recall: wilson(1, 2) });

    const two: Prediction = { ...one, kept: [kept(null, "held"), kept(RESERVATION_A, "held"), kept(RESERVATION_A, "held")] };
    expect(measure([item], [two]).all).toEqual({ precision: wilson(2, 3), recall: wilson(2, 2) });
  });
});

describe("a quote not in the text is dropped and counted", () => {
  it("drops it, nulls an id the session never showed, and reads an id without case", async () => {
    const item = fixtureItems()[0]!;
    const { predictions } = await predictAll([item], [
      answer(
        statement({ quote: "A TABLE for 2   held for you", reservation_id: RESERVATION_A.toUpperCase(), status: "held", party_size: 2 }),
        statement({ quote: "a table for 9 held for you", reservation_id: RESERVATION_A, status: "held" }),
        statement({ quote: "It stays held for ten minutes", reservation_id: "0199a000-0000-7000-8000-0000000000ff", status: "held" }),
      ),
    ]);

    const [prediction] = predictions;
    expect(prediction?.failed).toBeUndefined();
    expect(prediction?.dropped).toBe(1);
    expect(prediction?.kept).toEqual([
      { quote: "A TABLE for 2   held for you", claim: { reservation_id: RESERVATION_A, status: "held", party_size: 2 } },
      { quote: "It stays held for ten minutes", claim: { reservation_id: null, status: "held" } },
    ]);

    // the dropped quote counts in the report, and the statements that were kept are what the rates are over
    const report = measure([item], predictions);
    expect(report.dropped).toBe(1);
    expect(report.items).toBe(1);
    expect(report.all.precision).toMatchObject({ k: 1, n: 2 });
    expect(report.all.recall).toMatchObject({ k: 1, n: 1 });
  });
});

describe("predict", () => {
  it("sorts a failed call: a provider that cannot serve the judge throws, a request refused and a failure that may pass are stored, with no retry", async () => {
    const item = fixtureItems()[0]!;
    // an error as the SDK's APIError carries it: the status, and the API's parsed body on `error`; its own text must not get into the message
    const apiError = (status: number, type: string, details?: unknown): Step => () => {
      throw Object.assign(new Error("sk-ant-secret"), {
        status, error: { type: "error", error: { type, message: "sk-ant-secret", ...(details === undefined ? {} : { details }) } },
      });
    };
    const provider = scripted(
      failing(401), failing(403), apiError(402, "billing_error"), apiError(404, "not_found_error"),
      apiError(429, "rate_limit_error", { error_code: "enforced_spend_limit_reached" }),
      failing(400), failing(429), failing(), failing(500),
    );

    await expect(predict(provider, prompt, item)).rejects.toThrow("the model provider refused the requests (HTTP 401)");
    await expect(predict(provider, prompt, item)).rejects.toThrow("the model provider refused the requests (HTTP 403)");
    await expect(predict(provider, prompt, item)).rejects.toThrow("the model provider refused the requests (HTTP 402, billing_error)");
    await expect(predict(provider, prompt, item)).rejects.toThrow("the model provider refused the requests (HTTP 404, not_found_error)");
    // the message is the status and the API's error type: nothing of the error's own text
    await expect(predict(provider, prompt, item)).rejects.toThrow(/^the model provider refused the requests \(HTTP 429, rate_limit_error, enforced_spend_limit_reached\)$/);
    const nothing = { kept: [], dropped: 0, model: null, usage: null };
    expect(await predict(provider, prompt, item)).toEqual({ item: "a", ...nothing, failed: "provider_rejected" });
    // a 429 that is not the spend cap may pass
    expect(await predict(provider, prompt, item)).toEqual({ item: "a", ...nothing, failed: "provider_error" });
    expect(await predict(provider, prompt, item)).toEqual({ item: "a", ...nothing, failed: "provider_error" });
    expect(await predict(provider, prompt, item)).toEqual({ item: "a", ...nothing, failed: "provider_error" });
    expect(provider.requests).toHaveLength(9);
  });

  it("builds the request with the function the judge builds its own with", async () => {
    const item = fixtureItems()[0]!;
    const provider = scripted(answer());
    await predict(provider, prompt, item);
    const [sent] = provider.requests;
    const { signal, ...rest } = judgeRequest(prompt, item.input, AbortSignal.timeout(1_000));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect({ ...sent, signal: undefined }).toEqual({ ...rest, signal: undefined });
    expect(sent?.signal).toBeInstanceOf(AbortSignal);
  });

  it("stores a refusal, a truncation and a reply that does not parse as failed, with the model that answered and its tokens", async () => {
    const item = fixtureItems()[0]!;
    const truncated: Completion = { kind: "truncated", usage: { ...USAGE }, model: MODEL };
    const garbled: Completion = { ...replyWith("not json"), model: MODEL };
    const wrongShape: Completion = { ...replyWith({ message: "hi", claims: [] }), model: MODEL };
    const { predictions } = await predictAll([item, item, item, item], [refusal, truncated, garbled, wrongShape]);
    expect(predictions.map((p) => p.failed)).toEqual(["refused", "truncated", "unparsable", "unparsable"]);
    for (const p of predictions) expect(p).toMatchObject({ kept: [], dropped: 0, model: MODEL, usage: USAGE });
  });

  it("passes the call's time limit on as its signal", async () => {
    const item = fixtureItems()[0]!;
    let aborted: boolean | undefined;
    const provider = scripted(async (request) => {
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted = request.signal.aborted;
      throw new Error("timed out");
    });
    expect(await predict(provider, prompt, item, 20)).toMatchObject({ failed: "provider_error", model: null, usage: null });
    expect(aborted).toBe(true);
  });
});

describe("loadLabeled", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-labeled-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fileWith = (name: string, value: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };

  it("refuses a duplicate id and a label whose quote is not in its text, and hashes the bytes", () => {
    const { items, sha256 } = loadLabeled(FIXTURE);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(sha256).toBe(createHash("sha256").update(readFileSync(FIXTURE)).digest("hex"));

    // the same items written with other bytes read the same and hash differently
    const compact = loadLabeled(fileWith("compact.json", items));
    expect(compact.items).toEqual(items);
    expect(compact.sha256).not.toBe(sha256);
    expect(compact.sha256).toBe(createHash("sha256").update(JSON.stringify(items)).digest("hex"));

    expect(() => loadLabeled(fileWith("twice.json", [items[0], items[1], items[0]]))).toThrow(/item 2 repeats the id a/);

    const moved = structuredClone(items[0]!);
    moved.labels[0]!.quote = "a table for 3 held for you";
    expect(() => loadLabeled(fileWith("moved.json", [moved]))).toThrow(/item 0\.labels\[0\] quotes text that is not in the item's assistant_text/);
    // a quote is found without regard to case or runs of whitespace
    moved.labels[0]!.quote = "A TABLE for 2\n held   for you";
    expect(loadLabeled(fileWith("spaced.json", [moved])).items).toHaveLength(1);

    // a label may only name a reservation its item lists, read without case; a label with no reservation is always fine
    const named = structuredClone(items[0]!);
    named.labels[0]!.reservation_id = "0199a000-0000-7000-8000-0000000000ff";
    expect(() => loadLabeled(fileWith("unlisted.json", [named]))).toThrow(/item 0\.labels\[0\] names a reservation that is not in the item's input\.reservations/);
    named.labels[0]!.reservation_id = RESERVATION_A.toUpperCase();
    expect(loadLabeled(fileWith("upper.json", [named])).items).toHaveLength(1);
    named.labels[0]!.reservation_id = null;
    expect(loadLabeled(fileWith("none.json", [named])).items).toHaveLength(1);
  });

  it("refuses an item whose assistant text the judge makes no call for: one that is empty or only white space, or longer than the judge reads", () => {
    const item = fixtureItems()[0]!;
    // no label can quote a blank text, so the items are written with no labels: the refusal is of the text alone
    const withText = (assistant_text: string): unknown[] => [{ ...item, input: { ...item.input, assistant_text }, labels: [] }];

    for (const blank of ["", " ", "\n\t  \n"]) {
      expect(() => loadLabeled(fileWith("blank.json", withText(blank))), JSON.stringify(blank)).toThrow(
        /item 0\.input\.assistant_text must not be empty or only white space, for the judge makes no call for it/,
      );
    }
    expect(() => loadLabeled(fileWith("long.json", withText("x".repeat(MAX_TEXT_CHARS + 1))))).toThrow(
      /item 0\.input\.assistant_text is longer than 8000 characters, for the judge makes no call for it/,
    );
    // the limit is the judge's: 8,000 characters are read, and a character is a whole code point
    expect(loadLabeled(fileWith("exact.json", withText("y".repeat(MAX_TEXT_CHARS)))).items).toHaveLength(1);
    expect(loadLabeled(fileWith("wide.json", withText("\u{1F37D}".repeat(5_000)))).items).toHaveLength(1);
  });

  it("refuses a reservation's or a label's start that is not a date with an offset, and takes null and a date with one", () => {
    const item = fixtureItems()[0]!;
    const reservationAt = (starts_at: string | null): unknown[] => [{ ...item, input: { ...item.input, reservations: [{ id: RESERVATION_A, starts_at, party_size: 2 }] } }];
    const labelAt = (starts_at: string | null): unknown[] => [{ ...item, labels: [{ ...item.labels[0], starts_at }] }];

    expect(() => loadLabeled(fileWith("reservation-start.json", reservationAt("next Friday evening")))).toThrow(
      /item 0\.input\.reservations\[0\]\.starts_at must be a date with an offset, not "next Friday evening"/,
    );
    expect(() => loadLabeled(fileWith("label-start.json", labelAt("19h")))).toThrow(/item 0\.labels\[0\]\.starts_at must be a date with an offset, not "19h"/);
    // a time with no offset would be read in each machine's own zone
    expect(() => loadLabeled(fileWith("reservation-no-offset.json", reservationAt("2064-01-07T19:00")))).toThrow(
      /item 0\.input\.reservations\[0\]\.starts_at must be a date with an offset, not "2064-01-07T19:00"/,
    );
    expect(() => loadLabeled(fileWith("label-no-offset.json", labelAt("2064-01-07T19:00")))).toThrow(
      /item 0\.labels\[0\]\.starts_at must be a date with an offset, not "2064-01-07T19:00"/,
    );
    expect(() => loadLabeled(fileWith("label-no-offset-seconds.json", labelAt("2064-01-07T19:00:00")))).toThrow(/must be a date with an offset/);
    for (const fine of [null, "2064-01-07T19:00:00+05:00", "2064-01-07T14:00:00Z"]) {
      expect(loadLabeled(fileWith("fine-reservation.json", reservationAt(fine))).items).toHaveLength(1);
      expect(loadLabeled(fileWith("fine-label.json", labelAt(fine))).items).toHaveLength(1);
    }
  });

  it("refuses an unknown field, a value of the wrong kind, and a file that is not a list of items", () => {
    const [first] = fixtureItems();
    const item = first!;
    const withInput = (input: object): unknown[] => [{ ...item, input: { ...item.input, ...input } }];
    const refused = (value: unknown, pattern: RegExp): void => {
      expect(() => loadLabeled(fileWith("refused.json", value))).toThrow(pattern);
    };

    refused([{ ...item, note: "x" }], /item 0 has an unknown field note/);
    refused(withInput({ note: "x" }), /item 0\.input has an unknown field note/);
    refused([{ ...item, labels: [{ ...item.labels[0], note: 1 }] }], /item 0\.labels\[0\] has an unknown field note/);
    refused(withInput({ claims: [{ reservation_id: RESERVATION_A, status: "held", note: 1 }] }), /item 0\.input\.claims\[0\] has an unknown field note/);
    refused(withInput({ reservations: [{ id: RESERVATION_A, starts_at: null }] }), /item 0\.input\.reservations\[0\] has no party_size/);

    const noOrigin = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "origin"));
    refused([noOrigin], /item 0 has no origin/);
    refused([{ ...item, origin: "invented" }], /item 0\.origin must be one of live, variant, written/);
    refused([{ ...item, disagreed: "no" }], /item 0\.disagreed must be true or false/);
    refused([{ ...item, labels: [{ ...item.labels[0], status: "booked" }] }], /item 0\.labels\[0\]\.status must be one of/);
    refused([{ ...item, labels: [{ ...item.labels[0], party_size: 2.5 }] }], /item 0\.labels\[0\]\.party_size must be an integer or null/);

    refused({ items: [item] }, /must be a list of items/);
    refused("[{", /is not JSON/);
    expect(() => loadLabeled(join(dir, "missing.json"))).toThrow(/cannot be read/);
  });
});

describe("the judge mode of the live script", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-live-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const KEY = "sk-ant-test-key";
  const ENV = { ANTHROPIC_API_KEY: KEY };
  writeFileSync(join(dir, "dev.json"), readFileSync(FIXTURE));
  const written = (name: string): string => join(dir, name);

  const spies = () => ({
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  });
  const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((call) => String(call[0]));

  it("refuses an unknown part, a missing or bad setting and a part that is not there with one line, and exits 1", async () => {
    const { log, error } = spies();
    const outFile = written("never.json");
    const run = async (args: string[], env: Record<string, string | undefined>): Promise<string[]> => {
      error.mockClear();
      expect(await runJudgeMode(args, env, { provider: scripted(), labeledDir: dir, outFile }), args.join(" ")).toBe(1);
      return lines(error);
    };
    const usage = ["dastar-agent: usage: live.ts judge --part dev|held-out"];

    expect(await run([], ENV)).toEqual(usage);
    expect(await run(["--part"], ENV)).toEqual(usage);
    expect(await run(["--part", "test"], ENV)).toEqual(usage);
    expect(await run(["--part", "dev", "extra"], ENV)).toEqual(usage);
    expect(await run(["--part", "dev"], {})).toEqual(["dastar-agent: set ANTHROPIC_API_KEY"]);
    expect(await run(["--part", "dev"], { ANTHROPIC_API_KEY: "sk ant" })).toEqual(["dastar-agent: ANTHROPIC_API_KEY must contain only visible ASCII characters"]);
    expect(await run(["--part", "dev"], { ...ENV, JUDGE_EFFORT: "huge" })).toEqual(["dastar-agent: JUDGE_EFFORT must be one of low, medium, high, xhigh, max"]);
    const missing = await run(["--part", "held-out"], ENV);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^dastar-agent: the labeled set .*held-out\.json cannot be read/);

    const emptyDir = mkdtempSync(join(dir, "empty-"));
    writeFileSync(join(emptyDir, "dev.json"), "[]");
    error.mockClear();
    expect(await runJudgeMode(["--part", "dev"], ENV, { provider: scripted(), labeledDir: emptyDir, outFile })).toBe(1);
    expect(lines(error)).toEqual(["dastar-agent: the labeled part dev has no items"]);

    expect(log).not.toHaveBeenCalled();
    expect(() => readFileSync(outFile)).toThrow();
  });

  it("writes the report after each item and prints one line per measure and one for the run", async () => {
    const { log, error } = spies();
    const outFile = written("judge-accuracy.json");
    const seen: string[] = [];
    // the file after the first item holds that item alone: read it when the second call is made
    const second = FIXTURE_ANSWERS()[1]!;
    const checking = scripted(FIXTURE_ANSWERS()[0]!, () => {
      seen.push(readFileSync(outFile, "utf8"));
      return second;
    });

    expect(await runJudgeMode(["--part", "dev"], ENV, { provider: checking, labeledDir: dir, outFile })).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const afterFirst = JSON.parse(seen[0]!) as { predictions: unknown[]; report: { items: number } };
    expect(afterFirst.predictions).toHaveLength(1);
    expect(afterFirst.report.items).toBe(1);

    const text = readFileSync(outFile, "utf8");
    const record = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual([
      "mode", "part", "model", "effort", "prompt_hash", "labeled_set", "started_at", "items_total", "complete", "answered_models", "report", "predictions",
    ]);
    // both items were asked and answered, by the configured model
    expect(record).toMatchObject({ items_total: 2, complete: true, answered_models: { "claude-opus-5-5": 2 } });
    expect(JSON.parse(seen[0]!)).toMatchObject({ items_total: 2, complete: false, answered_models: { "claude-opus-5-5": 1 } });
    expect(record).toMatchObject({
      mode: "judge", part: "dev", model: "claude-opus-5-5", effort: "medium", prompt_hash: prompt.hash,
      labeled_set: { file: "judge/labeled/dev.json", sha256: createHash("sha256").update(readFileSync(FIXTURE)).digest("hex") },
    });
    expect(Number.isNaN(Date.parse(String(record["started_at"])))).toBe(false);
    expect((record["predictions"] as { item: string }[]).map((p) => p.item)).toEqual(["a", "b"]);
    const report = record["report"] as ReturnType<typeof measure>;
    expect(report).toEqual(measure(fixtureItems(), (record["predictions"] as Prediction[])));
    expect(report.undeclared.precision).toMatchObject({ k: 1, n: 2 });

    const printed = lines(log);
    expect(printed).toHaveLength(7);
    const interval = (name: string, value: string, counts: string): RegExp => new RegExp(`^${name} ${value} \\[\\d\\.\\d{3}, \\d\\.\\d{3}\\] \\(${counts}\\)$`);
    expect(printed[0]).toMatch(interval("undeclared precision", "0\\.500", "1/2"));
    expect(printed[1]).toMatch(interval("undeclared recall", "0\\.500", "1/2"));
    expect(printed[2]).toMatch(interval("all precision", "0\\.667", "2/3"));
    expect(printed[3]).toMatch(interval("all recall", "0\\.667", "2/3"));
    expect(printed[4]).toMatch(interval("field agreement", "0\\.500", "1/2"));
    expect(printed[5]).toMatch(interval("label agreement", "1\\.000", "1/1"));
    expect(printed[6]).toBe("items=2 dropped=0 failures={} input=200 output=40 cache_read=20 cache_write=10 cost_usd=0.0017");

    // nothing printed or written carries the key
    expect(JSON.stringify([printed, lines(error)]) + text).not.toContain(KEY);
  });

  it("prints n/a for a measure with no trials, and exits 1 when every item failed", async () => {
    const { log } = spies();
    const outFile = written("all-failed.json");
    expect(await runJudgeMode(["--part", "dev"], ENV, { provider: scripted(refusal, failing(500)), labeledDir: dir, outFile })).toBe(1);

    const report = (JSON.parse(readFileSync(outFile, "utf8")) as { report: ReturnType<typeof measure> }).report;
    expect(report.items).toBe(0);
    expect(report.failures).toEqual({ refused: 1, provider_error: 1 });
    expect(lines(log)[0]).toBe("undeclared precision n/a [n/a, n/a] (0/0)");
    expect(lines(log)[6]).toBe("items=0 dropped=0 failures={\"refused\":1,\"provider_error\":1} input=100 output=20 cache_read=10 cache_write=5 cost_usd=0.0008");
  });

  it("exits 1 and records the run as not complete when the provider fails on one item, however many others were measured", async () => {
    const { log, error } = spies();
    const outFile = written("one-failed.json");
    expect(await runJudgeMode(["--part", "dev"], ENV, { provider: scripted(FIXTURE_ANSWERS()[0]!, failing(500)), labeledDir: dir, outFile })).toBe(1);

    const record = JSON.parse(readFileSync(outFile, "utf8")) as { items_total: number; complete: boolean; answered_models: Record<string, number>; report: ReturnType<typeof measure> };
    // the first item was measured, and the run is still not a measurement of the part
    expect(record.report.items).toBe(1);
    expect(record.report.failures).toEqual({ provider_error: 1 });
    expect(record).toMatchObject({ items_total: 2, complete: false, answered_models: { "claude-opus-5-5": 1 } });
    expect(lines(error)).toEqual(["dastar-agent: the run is not complete: 1 of 2 items were not answered with statements or with a refusal, a truncation or a reply that did not parse"]);
    expect(lines(log)).toHaveLength(7);
  });

  it("counts a refusal as an answer, so a run with one is complete and exits 0, and the printed summary flags a model that is not the configured one", async () => {
    const { log, error } = spies();
    const outFile = written("refusal-and-other-model.json");
    const other: Completion = { ...FIXTURE_ANSWERS()[1]!, model: "another-model" };
    expect(await runJudgeMode(["--part", "dev"], ENV, { provider: scripted(refusal, other), labeledDir: dir, outFile })).toBe(0);

    const record = JSON.parse(readFileSync(outFile, "utf8")) as { complete: boolean; answered_models: Record<string, number>; report: ReturnType<typeof measure> };
    expect(record.complete).toBe(true);
    expect(record.answered_models).toEqual({ "claude-opus-5-5": 1, "another-model": 1 });
    expect(record.report.failures).toEqual({ refused: 1 });
    expect(error).not.toHaveBeenCalled();
    const printed = lines(log);
    expect(printed).toHaveLength(8);
    expect(printed[7]).toBe("answered by another-model, not the configured claude-opus-5-5: 1 item");
    expect(printed.slice(0, 7).join("\n")).not.toContain("answered by");
  });

  it("ends with one line and exit 1 when the provider refuses the key, keeping the items finished before it", async () => {
    const { log, error } = spies();
    const outFile = written("refused-key.json");
    expect(await runJudgeMode(["--part", "dev"], ENV, { provider: scripted(FIXTURE_ANSWERS()[0]!, failing(401)), labeledDir: dir, outFile })).toBe(1);
    expect(lines(error)).toEqual(["dastar-agent: the model provider refused the requests (HTTP 401)"]);
    expect(log).not.toHaveBeenCalled();
    expect((JSON.parse(readFileSync(outFile, "utf8")) as { predictions: unknown[] }).predictions).toHaveLength(1);
  });
});
