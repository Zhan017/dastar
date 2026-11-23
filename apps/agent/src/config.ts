export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type AgentConfig = {
  databaseUrl: string;
  dastarUrl: string;
  venueId: string;
  /** The key the agent's tools run with: it can hold and cancel but never confirm. */
  agentKey: string;
  /** The id of that key, which the agent's own tables are keyed by. */
  agentKeyId: string;
  /** The key the confirm button runs with: a different key, so that confirming is never something the tools can do. */
  demoConfirmKey: string;
  /** The 32 bytes the confirm tokens are signed with. */
  tokenKey: Buffer;
  anthropicApiKey: string;
  model: string;
  effort: Effort;
  host: string;
  port: number;
};

export type AgentConfigResult = { ok: true; config: AgentConfig } | { ok: false; line: string };

const SETTINGS = ["DATABASE_URL", "DASTAR_URL", "DASTAR_VENUE_ID", "AGENT_KEY", "AGENT_KEY_ID", "DEMO_CONFIRM_KEY", "DASTAR_TOKEN_KEY", "ANTHROPIC_API_KEY"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A key travels in a header, and the runtime's error for a bad header value quotes the value; a key of visible ASCII cannot cause one. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** The standard base64 alphabet with optional padding: Node's decoder skips any other character instead of failing, so the text is checked before it is decoded. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const TOKEN_KEY_BYTES = 32;
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_EFFORT: Effort = "medium";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8081;

const refuse = (line: string): AgentConfigResult => ({ ok: false, line });

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

/** Reads the agent's eight required settings and its optional ones (AGENT_MODEL, AGENT_EFFORT, AGENT_HOST, AGENT_PORT) from the environment, refusing with one line that names what to fix. */
export function readAgentConfig(env: Record<string, string | undefined>): AgentConfigResult {
  const read = (name: string): string => (env[name] ?? "").trim();

  const missing = SETTINGS.filter((name) => read(name) === "");
  if (missing.length > 0) {
    return refuse(
      `set DATABASE_URL, DASTAR_URL, DASTAR_VENUE_ID, AGENT_KEY, AGENT_KEY_ID, DEMO_CONFIRM_KEY, DASTAR_TOKEN_KEY and ANTHROPIC_API_KEY; missing: ${missing.join(", ")}`,
    );
  }

  const databaseUrl = read("DATABASE_URL");
  const dastarUrl = read("DASTAR_URL");
  const venueId = read("DASTAR_VENUE_ID");
  const agentKey = read("AGENT_KEY");
  const agentKeyId = read("AGENT_KEY_ID");
  const demoConfirmKey = read("DEMO_CONFIRM_KEY");
  const tokenKeyText = read("DASTAR_TOKEN_KEY");
  const anthropicApiKey = read("ANTHROPIC_API_KEY");

  const parsed = parseUrl(dastarUrl);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return refuse("DASTAR_URL must be an http or https URL");
  if (parsed.username !== "" || parsed.password !== "") return refuse("DASTAR_URL must not include a user name or password");
  if (!UUID.test(venueId)) return refuse("DASTAR_VENUE_ID must be a uuid");
  if (!UUID.test(agentKeyId)) return refuse("AGENT_KEY_ID must be a uuid");
  if (!VISIBLE_ASCII.test(agentKey)) return refuse("AGENT_KEY must contain only visible ASCII characters");
  if (!VISIBLE_ASCII.test(demoConfirmKey)) return refuse("DEMO_CONFIRM_KEY must contain only visible ASCII characters");
  if (!VISIBLE_ASCII.test(anthropicApiKey)) return refuse("ANTHROPIC_API_KEY must contain only visible ASCII characters");
  if (agentKey === demoConfirmKey) return refuse("AGENT_KEY and DEMO_CONFIRM_KEY must be different keys");

  const tokenKey = BASE64.test(tokenKeyText) ? Buffer.from(tokenKeyText, "base64") : null;
  if (tokenKey === null || tokenKey.length !== TOKEN_KEY_BYTES) return refuse("DASTAR_TOKEN_KEY must be 32 bytes in base64");

  const effort = read("AGENT_EFFORT") || DEFAULT_EFFORT;
  if (!isEffort(effort)) return refuse(`AGENT_EFFORT must be one of ${EFFORTS.join(", ")}`);

  const portText = read("AGENT_PORT");
  const port = portText === "" ? DEFAULT_PORT : /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port > 65535) return refuse("AGENT_PORT must be an integer from 0 to 65535");

  return {
    ok: true,
    config: {
      databaseUrl,
      dastarUrl,
      venueId: venueId.toLowerCase(),
      agentKey,
      agentKeyId: agentKeyId.toLowerCase(),
      demoConfirmKey,
      tokenKey,
      anthropicApiKey,
      model: read("AGENT_MODEL") || DEFAULT_MODEL,
      effort,
      host: read("AGENT_HOST") || DEFAULT_HOST,
      port,
    },
  };
}
