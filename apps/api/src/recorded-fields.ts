export type RecordedTool =
  | "hold" | "list_holds" | "search_availability" | "get_reservation" | "cancel" | "seat" | "complete" | "confirm" | "confirm_token";

type Fields = Record<string, unknown>;

/** What a request's validated parts hold; a part the route does not declare is absent. */
export type ValidParts = { param?: unknown; json?: unknown; header?: unknown };

const asObject = (v: unknown): Fields => (typeof v === "object" && v !== null && !Array.isArray(v) ? v as Fields : {});
const lower = (v: unknown): unknown => (typeof v === "string" ? v.toLowerCase() : v);
/** Only a plain value is ever stored: an object or an array in a named field is dropped. */
const scalar = (v: unknown): unknown => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined);
const compact = (o: Fields): Fields => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const RECEIPT_KEYS = ["reservation_id", "status", "version", "audit_id", "trace_id"] as const;

/**
 * The fields of a call's request that are stored, and no others: never the key, a confirm token, an external reference,
 * or a cancel reason. Ids are lowercased, as the routes read them.
 */
export function recordedInput(tool: RecordedTool, valid: ValidParts): Fields {
  const json = asObject(valid.json);
  const reservationId = lower(asObject(valid.param).id);
  switch (tool) {
    case "hold": {
      const assignment = asObject(json.assignment);
      return compact({
        party_size: json.party_size, starts_at: json.starts_at, duration_minutes: json.duration_minutes,
        assignment: compact({ kind: assignment.kind, id: lower(assignment.id) }),
        idempotency_key: asObject(valid.header)["idempotency-key"],
      });
    }
    case "search_availability":
      return compact({ party_size: json.party_size, from: json.from, to: json.to });
    case "list_holds":
      return {};
    case "get_reservation":
      return compact({ reservation_id: reservationId });
    case "cancel": case "seat": case "complete": case "confirm": case "confirm_token":
      return compact({ reservation_id: reservationId, expected_version: json.expected_version });
  }
}

function receiptOf(v: unknown): Fields | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Fields;
  return compact(Object.fromEntries(RECEIPT_KEYS.map((k) => [k, scalar(r[k])])));
}

function pick(from: unknown, keys: readonly string[]): Fields {
  const o = asObject(from);
  return compact(Object.fromEntries(keys.map((k) => [k, scalar(o[k])])));
}

/**
 * The fields of a call's answer that are stored. A 2xx keeps the fields of its tool's row of the table; any other
 * status keeps the problem's code and nothing else, so a problem's detail never reaches the log. A body that is not
 * the shape the route answers with yields what can be read from it, and never throws.
 */
export function recordedOutcome(tool: RecordedTool, status: number, body: unknown): { output: Fields; receipt: Fields | null } {
  const b = asObject(body);
  if (status < 200 || status >= 300) {
    return { output: compact({ code: typeof b.code === "string" ? b.code : undefined }), receipt: null };
  }
  switch (tool) {
    case "hold":
      return { output: pick(b, ["hold_expires_at", "replayed"]), receipt: receiptOf(b.receipt) };
    case "search_availability":
      return { output: compact({ slots: Array.isArray(b.slots) ? b.slots.length : undefined, truncated: scalar(b.truncated) }), receipt: null };
    case "list_holds":
      return {
        output: compact({ holds: Array.isArray(b.holds) ? b.holds.map((h) => pick(h, ["id", "starts_at", "party_size", "hold_expires_at"])) : undefined }),
        receipt: null,
      };
    case "get_reservation":
      return { output: pick(b, ["id", "status", "starts_at", "party_size", "hold_expires_at", "version"]), receipt: null };
    case "cancel": case "seat": case "complete": case "confirm":
      return { output: {}, receipt: receiptOf(b.receipt) };
    case "confirm_token":
      return { output: pick(b, ["version"]), receipt: null };
  }
}
