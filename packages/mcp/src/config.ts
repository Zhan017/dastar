export type McpConfig = { url: string; key: string; venueId: string };

export type ConfigResult = { ok: true; config: McpConfig } | { ok: false; line: string };

const SETTINGS = ["DASTAR_URL", "DASTAR_KEY", "DASTAR_VENUE_ID"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (line: string): ConfigResult => ({ ok: false, line });

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Reads the server's three settings from the environment, refusing with one line that names what to fix. */
export function readConfig(env: Record<string, string | undefined>): ConfigResult {
  const missing = SETTINGS.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) return refuse(`set ${SETTINGS[0]}, ${SETTINGS[1]} and ${SETTINGS[2]}; missing: ${missing.join(", ")}`);

  const url = env["DASTAR_URL"] ?? "";
  const key = (env["DASTAR_KEY"] ?? "").trim();
  const venueId = env["DASTAR_VENUE_ID"] ?? "";

  const parsed = parseUrl(url);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return refuse("DASTAR_URL must be an http or https URL");
  if (parsed.username !== "" || parsed.password !== "") return refuse("DASTAR_URL must not include a user name or password");
  if (!UUID.test(venueId)) return refuse("DASTAR_VENUE_ID must be a uuid");

  return { ok: true, config: { url, key, venueId: venueId.toLowerCase() } };
}
