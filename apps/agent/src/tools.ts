import { INPUT_SCHEMAS, TOOLS, type ToolName } from "@dastar/agent-tools";

export type JsonSchema = Record<string, unknown>;

/** A tool as the model provider takes it: its name, what it does, and a strict schema for its input. */
export type ProviderTool = { name: ToolName; description: string; inputSchema: JsonSchema };

/** The schema keywords `validateArgs` checks, and so the only ones the tools' input schemas may use (the test over `INPUT_SCHEMAS` holds them to it). */
export const KNOWN_KEYWORDS: ReadonlySet<string> = new Set(["type", "properties", "required", "enum", "format", "minimum", "maximum", "minLength", "maxLength"]);

/** The provider's strict mode takes no numeric or length limits, so they are dropped from what it is sent; `validateArgs` still holds a call to them. */
const LIMITS = new Set(["minimum", "maximum", "minLength", "maxLength"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `schema` with the limits dropped and `additionalProperties: false` on every object, as a new value; the schema given is not changed. */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const strict: JsonSchema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (LIMITS.has(keyword)) continue;
    if (keyword === "properties" && isRecord(value)) {
      strict[keyword] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, isRecord(child) ? strictSchema(child) : child]));
    } else {
      strict[keyword] = Array.isArray(value) ? [...value] : value;
    }
  }
  if (strict["type"] === "object") strict["additionalProperties"] = false;
  return strict;
}

/** The agent holds without an external_ref: it is text a person writes into the venue's record, and the agent has nothing of its own to put there. */
function withoutExternalRef(schema: JsonSchema): JsonSchema {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  return { ...schema, properties: Object.fromEntries(Object.entries(properties).filter(([name]) => name !== "external_ref")) };
}

export const AGENT_INPUT_SCHEMAS: Record<ToolName, JsonSchema> = {
  search_availability: INPUT_SCHEMAS.search_availability,
  hold: withoutExternalRef(INPUT_SCHEMAS.hold),
  cancel: INPUT_SCHEMAS.cancel,
  get_reservation: INPUT_SCHEMAS.get_reservation,
};

export const AGENT_TOOLS: readonly ProviderTool[] = TOOLS.map(({ name, description }) => ({
  name,
  description,
  inputSchema: strictSchema(AGENT_INPUT_SCHEMAS[name]),
}));

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/** RFC 3339: a date and a time with an offset or Z, and a calendar date that exists. */
function isDateTime(text: string): boolean {
  const match = DATE_TIME.exec(text);
  if (match === null) return false;
  const part = (index: number): number => Number(match[index] ?? "0");
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, offsetHour = 0, offsetMinute = 0] = [1, 2, 3, 4, 5, 6, 7, 8].map(part);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

const child = (path: string, name: string): string => (path === "" ? name : `${path}.${name}`);
const present = (object: Record<string, unknown>, name: string): boolean => Object.hasOwn(object, name) && object[name] !== undefined;

function check(schema: JsonSchema, value: unknown, path: string): string | null {
  const at = path === "" ? "(input)" : path;
  const type = schema["type"];

  if (type === "object") {
    if (!isRecord(value)) return `${at}: must be an object`;
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    for (const name of required) {
      if (typeof name === "string" && !present(value, name)) return `${child(path, name)}: is required`;
    }
    for (const [name, property] of Object.entries(properties)) {
      if (!present(value, name) || !isRecord(property)) continue;
      const problem = check(property, value[name], child(path, name));
      if (problem !== null) return problem;
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) return `${child(path, name)}: is not allowed`;
    }
    return null;
  }

  if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return `${at}: must be an integer`;
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if (typeof minimum === "number" && value < minimum) return `${at}: must be at least ${minimum}`;
    if (typeof maximum === "number" && value > maximum) return `${at}: must be at most ${maximum}`;
    return null;
  }

  if (type === "string") {
    if (typeof value !== "string") return `${at}: must be a string`;
    const minLength = schema["minLength"];
    const maxLength = schema["maxLength"];
    if (typeof minLength === "number" && value.length < minLength) return `${at}: must be at least ${minLength} characters long`;
    if (typeof maxLength === "number" && value.length > maxLength) return `${at}: must be at most ${maxLength} characters long`;
    const format = schema["format"];
    if (format === "uuid" && !UUID.test(value)) return `${at}: must be a uuid`;
    if (format === "date-time" && !isDateTime(value)) return `${at}: must be a date-time`;
    if (format !== undefined && format !== "uuid" && format !== "date-time") throw new Error(`validateArgs does not support the string format ${JSON.stringify(format)}`);
    const options = schema["enum"];
    if (Array.isArray(options) && !options.includes(value)) return `${at}: must be one of ${options.join(", ")}`;
    return null;
  }

  throw new Error(`validateArgs does not support the schema type ${JSON.stringify(type)}`);
}

/** Holds a model's tool arguments to the schema it was given, before anything is sent: null when they are valid, else "<path>: <problem>" for the first problem found. */
export function validateArgs(schema: JsonSchema, value: unknown): string | null {
  return check(schema, value, "");
}
