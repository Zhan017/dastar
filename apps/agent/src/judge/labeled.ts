import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLAIM_STATUSES, quoteOccurs, type Claim, type ClaimStatus, type JudgeStatement } from "@dastar/db";
import type { JudgeInput, JudgeReservation } from "./input.js";

/** One assistant turn with the statements a careful reader finds in it. */
export type LabeledItem = {
  id: string;
  /** The source the turn comes from; a part never splits a family. */
  family: string;
  origin: "live" | "variant" | "written";
  labeled_by: "construction" | "two-pass";
  /** For a two-pass item: whether its two passes disagreed before they were settled. */
  disagreed: boolean;
  input: JudgeInput;
  labels: JudgeStatement[];
};

/** The folder of the labeled parts: dev.json and held-out.json. */
export const LABELED_DIR: string = fileURLToPath(new URL("../../judge/labeled", import.meta.url));

const ORIGINS: readonly string[] = ["live", "variant", "written"];
const LABELED_BY: readonly string[] = ["construction", "two-pass"];

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object at `where` with exactly its required fields and, at most, its optional ones. */
function exact(value: unknown, where: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Error(`${where} has an unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${where} has no ${key}`);
  }
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

function nonEmpty(value: unknown, where: string): string {
  const s = text(value, where);
  if (s === "") throw new Error(`${where} must not be empty`);
  return s;
}

function nullableText(value: unknown, where: string): string | null {
  return value === null ? null : text(value, where);
}

function nullableInteger(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${where} must be an integer or null`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[], where: string): T {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${where} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value as unknown[];
}

function reservation(value: unknown, where: string): JudgeReservation {
  const o = exact(value, where, ["id", "starts_at", "party_size"]);
  return { id: nonEmpty(o["id"], `${where}.id`), starts_at: nullableText(o["starts_at"], `${where}.starts_at`), party_size: nullableInteger(o["party_size"], `${where}.party_size`) };
}

function declared(value: unknown, where: string): Claim {
  const o = exact(value, where, ["reservation_id", "status"], ["starts_at", "party_size", "quote"]);
  const claim: Claim = {
    reservation_id: nonEmpty(o["reservation_id"], `${where}.reservation_id`),
    status: oneOf<ClaimStatus>(o["status"], CLAIM_STATUSES, `${where}.status`),
  };
  if (o["starts_at"] !== undefined) claim.starts_at = text(o["starts_at"], `${where}.starts_at`);
  if (o["party_size"] !== undefined) {
    const size = o["party_size"];
    if (typeof size !== "number" || !Number.isFinite(size)) throw new Error(`${where}.party_size must be a number`);
    claim.party_size = size;
  }
  if (o["quote"] !== undefined) claim.quote = text(o["quote"], `${where}.quote`);
  return claim;
}

function label(value: unknown, where: string): JudgeStatement {
  const o = exact(value, where, ["quote", "reservation_id", "status", "starts_at", "party_size"]);
  return {
    quote: nonEmpty(o["quote"], `${where}.quote`),
    reservation_id: nullableText(o["reservation_id"], `${where}.reservation_id`),
    status: oneOf<ClaimStatus>(o["status"], CLAIM_STATUSES, `${where}.status`),
    starts_at: nullableText(o["starts_at"], `${where}.starts_at`),
    party_size: nullableInteger(o["party_size"], `${where}.party_size`),
  };
}

function item(value: unknown, where: string): LabeledItem {
  const o = exact(value, where, ["id", "family", "origin", "labeled_by", "disagreed", "input", "labels"]);
  const disagreed = o["disagreed"];
  if (typeof disagreed !== "boolean") throw new Error(`${where}.disagreed must be true or false`);
  const input = exact(o["input"], `${where}.input`, ["reservations", "user_text", "assistant_text", "claims"]);
  const assistantText = text(input["assistant_text"], `${where}.input.assistant_text`);
  const reservations = list(input["reservations"], `${where}.input.reservations`).map((r, i) => reservation(r, `${where}.input.reservations[${i}]`));
  const listed = new Set(reservations.map((r) => r.id.toLowerCase()));
  const labels = list(o["labels"], `${where}.labels`).map((l, i) => label(l, `${where}.labels[${i}]`));
  for (const [i, l] of labels.entries()) {
    if (!quoteOccurs(assistantText, l.quote)) throw new Error(`${where}.labels[${i}] quotes text that is not in the item's assistant_text`);
    // the judge is shown only the listed reservations, so a label naming another could never be matched
    if (l.reservation_id !== null && !listed.has(l.reservation_id.toLowerCase())) {
      throw new Error(`${where}.labels[${i}] names a reservation that is not in the item's input.reservations`);
    }
  }
  return {
    id: nonEmpty(o["id"], `${where}.id`),
    family: nonEmpty(o["family"], `${where}.family`),
    origin: oneOf<LabeledItem["origin"]>(o["origin"], ORIGINS, `${where}.origin`),
    labeled_by: oneOf<LabeledItem["labeled_by"]>(o["labeled_by"], LABELED_BY, `${where}.labeled_by`),
    disagreed,
    input: {
      reservations,
      user_text: nullableText(input["user_text"], `${where}.input.user_text`),
      assistant_text: assistantText,
      claims: list(input["claims"], `${where}.input.claims`).map((c, i) => declared(c, `${where}.input.claims[${i}]`)),
    },
    labels,
  };
}

/** The part's items and the SHA-256 of the file's bytes; refuses a duplicate id, an unknown field, a label whose quote is not in its text, or a label naming a reservation its item does not list. */
export function loadLabeled(file: string): { items: LabeledItem[]; sha256: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new Error(`the labeled set ${file} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new Error(`the labeled set ${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`the labeled set ${file} must be a list of items`);

  const ids = new Set<string>();
  const items = (parsed as unknown[]).map((value, i) => {
    let read: LabeledItem;
    try {
      read = item(value, `item ${i}`);
    } catch (e) {
      throw new Error(`the labeled set ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ids.has(read.id)) throw new Error(`the labeled set ${file}: item ${i} repeats the id ${read.id}`);
    ids.add(read.id);
    return read;
  });
  return { items, sha256: createHash("sha256").update(bytes).digest("hex") };
}
