import { isDeclared, screenStatements, statementClaim, type Interval, type JudgeFailure, type Rates, type StatementClaim } from "@dastar/db";
import type { Completion, LLMProvider, Usage } from "../provider.js";
import type { LabeledItem } from "./labeled.js";
import { JUDGE_REPLY_SCHEMA, renderJudgeMessage, type LoadedJudgePrompt } from "./prompt.js";
import { parseJudgeReply } from "./reply.js";
import { CALL_TIMEOUT_MS, classifyProviderError } from "./turn.js";

/** Dollars per million tokens, by the model that answered; a model that is not here has no cost. */
export const PRICES_PER_MTOK: Readonly<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

const Z = 1.96;

/** The Wilson score interval of k out of n at 95%; no trials give nothing but the counts. */
export function wilson(k: number, n: number): Interval {
  if (n === 0) return { value: null, low: null, high: null, k, n };
  const p = k / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { value: p, low: Math.max(0, center - half), high: Math.min(1, center + half), k, n };
}

/** What the judge found in one item: the statements that quote the text, the quotes dropped, or why the item failed; the model that answered and the tokens it used when a call was answered. */
export type Prediction = {
  item: string;
  kept: { quote: string; claim: StatementClaim }[];
  dropped: number;
  failed?: JudgeFailure;
  model: string | null;
  usage: Usage | null;
};

/**
 * Asks the model for the statements in one item, once, as the judge asks for a turn's. A key the provider refuses
 * throws; any other failure of the call, a refusal, a truncation and a reply that does not parse come back as a failed
 * prediction.
 */
export async function predict(provider: LLMProvider, prompt: LoadedJudgePrompt, item: LabeledItem, timeoutMs: number = CALL_TIMEOUT_MS): Promise<Prediction> {
  const { input } = item;
  const failed = (reason: JudgeFailure, answered?: Completion): Prediction => ({
    item: item.id, kept: [], dropped: 0, failed: reason, model: answered?.model ?? null, usage: answered?.usage ?? null,
  });

  let completion: Completion;
  try {
    completion = await provider.complete({
      system: prompt.system,
      messages: [{ role: "user", text: renderJudgeMessage(prompt.template, input) }],
      tools: [],
      replySchema: JUDGE_REPLY_SCHEMA,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const kind = classifyProviderError(error);
    if (kind === "config") throw new Error("the model provider refused the key (HTTP 401 or 403)");
    return failed(kind === "rejected" ? "provider_rejected" : "provider_error");
  }

  if (completion.kind === "refused" || completion.kind === "truncated") return failed(completion.kind, completion);
  const statements = completion.kind === "reply" ? parseJudgeReply(completion.text) : null;
  if (statements === null) return failed("unparsable", completion);

  const known = new Set(input.reservations.map((r) => r.id.toLowerCase()));
  const { kept, dropped } = screenStatements(input.assistant_text, statements, known);
  return { item: item.id, kept, dropped, model: completion.model, usage: completion.usage };
}

export type AccuracyReport = {
  /** The items measured: those whose call was answered with statements. */
  items: number;
  undeclared: Rates;
  all: Rates;
  field_agreement: Interval;
  label_agreement: Interval;
  dropped: number;
  failures: Partial<Record<JudgeFailure, number>>;
  usage: Usage;
  cost_usd: number | null;
};

const sameReservation = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : a.toLowerCase() === b.toLowerCase());

/** Whether two starts agree: neither is stated, or both are and name the same instant. */
function sameStart(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

function costOf(usage: Usage, price: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000;
}

type Tally = { k: number; n: number };
const tally = (): Tally => ({ k: 0, n: 0 });
const rate = ({ k, n }: Tally): Interval => wilson(k, n);

/** The price of a model's tokens, or undefined for a model that has none. */
const priceOf = (model: string | null): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined =>
  model !== null && Object.hasOwn(PRICES_PER_MTOK, model) ? PRICES_PER_MTOK[model] : undefined;

/**
 * The agreement of the predictions with the labels, item by item. A prediction matches a label with the same
 * reservation (none to none) and status, one to one, the labels in order each taking the first prediction not yet
 * taken. An item whose call failed is counted in `failures` and in no rate but the label agreement, which is over the
 * labels and so over every two-pass item; an item with no prediction is not measured.
 */
export function measure(items: readonly LabeledItem[], predictions: readonly Prediction[]): AccuracyReport {
  const byItem = new Map(predictions.map((p): [string, Prediction] => [p.item, p]));

  let measured = 0;
  let dropped = 0;
  const failures: Partial<Record<JudgeFailure, number>> = {};
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost: number | null = 0;

  const undeclaredPredicted = tally();
  const undeclaredLabeled = tally();
  const allPredicted = tally();
  const allLabeled = tally();
  const fields = tally();
  const passes = tally();

  for (const item of items) {
    // the agreement of the two labeling passes is a property of the labels: every two-pass item counts, whatever its call did
    if (item.labeled_by === "two-pass") {
      passes.n++;
      if (!item.disagreed) passes.k++;
    }

    const prediction = byItem.get(item.id);
    if (prediction === undefined) continue;

    dropped += prediction.dropped;
    if (prediction.usage !== null) {
      usage.input += prediction.usage.input;
      usage.output += prediction.usage.output;
      usage.cacheRead += prediction.usage.cacheRead;
      usage.cacheWrite += prediction.usage.cacheWrite;
      const price = priceOf(prediction.model);
      cost = cost === null || price === undefined ? null : cost + costOf(prediction.usage, price);
    }
    if (prediction.failed !== undefined) {
      failures[prediction.failed] = (failures[prediction.failed] ?? 0) + 1;
      continue;
    }
    measured++;

    // each label, in order, takes the first prediction not yet taken that has its reservation and status
    const labels = item.labels.map(statementClaim);
    const predicted = prediction.kept.map((k) => k.claim);
    const takenBy = new Map<number, number>(); // label index -> prediction index
    const taken = new Set<number>();
    labels.forEach((label, i) => {
      const j = predicted.findIndex((p, at) => !taken.has(at) && sameReservation(label.reservation_id, p.reservation_id) && label.status === p.status);
      if (j < 0) return;
      taken.add(j);
      takenBy.set(i, j);
    });

    predicted.forEach((claim, j) => {
      const matched = taken.has(j);
      allPredicted.n++;
      if (matched) allPredicted.k++;
      if (!isDeclared(claim, item.input.claims)) {
        undeclaredPredicted.n++;
        if (matched) undeclaredPredicted.k++;
      }
    });
    labels.forEach((claim, i) => {
      const matched = takenBy.has(i);
      allLabeled.n++;
      if (matched) allLabeled.k++;
      if (!isDeclared(claim, item.input.claims)) {
        undeclaredLabeled.n++;
        if (matched) undeclaredLabeled.k++;
      }
    });

    for (const [i, j] of takenBy) {
      const label = labels[i];
      const found = predicted[j];
      if (label === undefined || found === undefined) continue;
      fields.n++;
      if (sameStart(label.starts_at, found.starts_at) && label.party_size === found.party_size) fields.k++;
    }
  }

  return {
    items: measured,
    undeclared: { precision: rate(undeclaredPredicted), recall: rate(undeclaredLabeled) },
    all: { precision: rate(allPredicted), recall: rate(allLabeled) },
    field_agreement: rate(fields),
    label_agreement: rate(passes),
    dropped,
    failures,
    usage,
    cost_usd: cost,
  };
}
