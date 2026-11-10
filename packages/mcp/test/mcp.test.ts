import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDastarClient } from "@dastar/client";
import { INPUT_SCHEMAS, TOOLS } from "@dastar/agent-tools";
import { listen, parseConfig } from "@dastar/api/server";
import { createKey } from "@dastar/api/auth";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../db/test/helpers/seed.js";
import { BUNDLE, buildBundle } from "../scripts/build.js";

type Slot = { starts_at: string; duration_minutes: number; assignment: { kind: "unit" | "combo"; id: string } };
type Held = { receipt: { reservation_id: string; status: string } };
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; dependencies: Record<string, string>; bin: unknown; files: unknown };

/** Runs the built server with only these variables and stdin closed, and collects what it writes. */
function runBundle(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

describe("dastar-mcp, the built server over stdio", () => {
  let conn: Conn; let owner: PgClient; let seed: Seed; let other: Seed; let pool: Pool;
  let api: Awaited<ReturnType<typeof listen>>;
  const keys: Record<"agent" | "confirm" | "admin" | "revoked", { id: string; key: string }> = {} as never;
  const env = (key: string, venue = seed.venue): Record<string, string> => ({ DASTAR_URL: api.url, DASTAR_KEY: key, DASTAR_VENUE_ID: venue });
  const connectWith = async (key: string): Promise<Client> => {
    const client = new Client({ name: "dastar-mcp-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE], env: env(key), stderr: "pipe" }));
    return client;
  };

  beforeAll(async () => {
    await buildBundle();
    conn = await cloneDatabase("mcp_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    other = await seedVenue(owner);
    pool = new Pool({ connectionString: conn.app, max: 2 });
    pool.on("error", () => undefined);
    const make = (label: string, capabilities: string[]) => createKey(pool, { label, capabilities, venueIds: [seed.venue] });
    keys.agent = await make("agent", ["read", "hold", "cancel"]);
    keys.confirm = await make("confirm", ["read", "hold", "confirm"]);
    keys.admin = await make("admin", ["read", "hold", "cancel", "admin"]);
    keys.revoked = await make("revoked", ["read", "hold", "cancel"]);
    api = await listen(parseConfig({ DATABASE_URL: conn.app, HOST: "127.0.0.1", PORT: "0" }), { log: () => undefined });
    const admin = createDastarClient({ baseUrl: api.url, key: keys.admin.key });
    const revoked = await admin.POST("/admin/venues/{id}/keys/{keyId}/revoke", { params: { path: { id: seed.venue, keyId: keys.revoked.id } } });
    expect(revoked.error).toBeUndefined();
    // 2064-01-07 is a Monday; 17:00 to 23:00 in Berlin is 16:00 to 22:00 UTC in January
    const schedule = await admin.POST("/admin/venues/{id}/schedules", {
      params: { path: { id: seed.venue } },
      body: { day_of_week: 1, opens: "17:00", closes: "23:00", duration_by_size: { "2": 90 } },
    });
    expect(schedule.error).toBeUndefined();
  });
  afterAll(async () => { await api.close(); await pool.end(); await owner.end(); await dropDatabase("mcp_test"); });

  it("lists the four tools with their committed inputs, titles, descriptions, and annotations", async () => {
    const client = await connectWith(keys.agent.key);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["cancel", "get_reservation", "hold", "search_availability"]);
      for (const def of TOOLS) {
        const listed = tools.find((t) => t.name === def.name)!;
        expect(listed.inputSchema, def.name).toEqual(INPUT_SCHEMAS[def.name]);
        expect(listed).toMatchObject({ title: def.title, description: def.description, annotations: def.annotations });
      }
      expect(client.getServerVersion()).toMatchObject({ name: "dastar", version: manifest.version });
    } finally {
      await client.close();
    }
  });

  it("books through the tools: search, hold, read, cancel, and refuses a cancel of a reservation it did not create", async () => {
    const client = await connectWith(keys.agent.key);
    try {
      const found = await client.callTool({ name: "search_availability", arguments: { party_size: 2, from: "2064-01-07T00:00:00Z", to: "2064-01-08T00:00:00Z", limit: 5 } });
      expect(found.isError).toBeFalsy();
      const slot = (found.structuredContent as { slots: Slot[] }).slots[0]!;
      const held = await client.callTool({ name: "hold", arguments: { party_size: 2, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, assignment: slot.assignment } });
      expect(held.isError).toBeFalsy();
      const id = (held.structuredContent as Held).receipt.reservation_id;
      expect(held.content).toEqual([{ type: "text", text: expect.stringMatching(new RegExp(`^Held reservation ${id} until `)) }]);
      const read = await client.callTool({ name: "get_reservation", arguments: { reservation_id: id } });
      expect(read.structuredContent).toMatchObject({ id, status: "held", venue_id: seed.venue });
      const cancelled = await client.callTool({ name: "cancel", arguments: { reservation_id: id, reason: "plans changed" } });
      expect(cancelled.structuredContent).toMatchObject({ receipt: { reservation_id: id, status: "cancelled" } });
      const foreign = await client.callTool({ name: "cancel", arguments: { reservation_id: "0199a000-0000-7000-8000-0000000000ff", reason: "not mine" } });
      expect(foreign).toMatchObject({ isError: true, structuredContent: { code: "not_created_in_session" } });
    } finally {
      await client.close();
    }
  });

  it("refuses arguments that break the input schema before any request", async () => {
    const client = await connectWith(keys.agent.key);
    try {
      const good = { party_size: 2, starts_at: "2064-01-07T19:00:00Z", duration_minutes: 90, assignment: { kind: "unit", id: seed.units[0]! } };
      for (const args of [{ ...good, party_size: "two" }, { ...good, starts_at: "next tuesday" }, { ...good, assignment: { kind: "unit", id: "T1" } }, { ...good, party_size: undefined }]) {
        const r = await client.callTool({ name: "hold", arguments: args });
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(r.content, JSON.stringify(args)).toEqual([{ type: "text", text: expect.stringContaining("Input validation error: Invalid arguments for tool hold") }]);
      }
    } finally {
      await client.close();
    }
    const holds = await createDastarClient({ baseUrl: api.url, key: keys.agent.key }).GET("/v1/venues/{id}/holds", { params: { path: { id: seed.venue } } });
    expect(holds.data?.holds).toEqual([]);
  });

  it("refuses to start with a key that can confirm or administer, a venue outside the key's, a revoked key, or a missing setting", async () => {
    const cases: [string, Record<string, string>, RegExp][] = [
      ["confirm", env(keys.confirm.key), /^dastar-mcp: the key can confirm reservations, and this server takes only keys that cannot; create one with: pnpm keys:create --label mcp --capabilities read,hold,cancel --venues /],
      ["admin", env(keys.admin.key), /^dastar-mcp: the key has the admin capability, and this server takes only keys without it; /],
      ["venue", env(keys.agent.key, other.venue), new RegExp(`^dastar-mcp: venue ${other.venue} is not among the key's venues; `)],
      ["revoked", env(keys.revoked.key), /^dastar-mcp: the key was not accepted: it is unknown or revoked; /],
      ["missing", { DASTAR_URL: api.url, DASTAR_VENUE_ID: seed.venue }, /^dastar-mcp: set DASTAR_URL, DASTAR_KEY and DASTAR_VENUE_ID; missing: DASTAR_KEY$/],
    ];
    for (const [name, e, line] of cases) {
      const run = await runBundle(e);
      expect(run.code, name).toBe(1);
      expect(run.stdout, name).toBe("");
      expect(run.stderr.endsWith("\n"), name).toBe(true);
      expect(run.stderr.trimEnd().split("\n"), name).toHaveLength(1);
      expect(run.stderr.trimEnd(), name).toMatch(line);
      if (e.DASTAR_KEY !== undefined) expect(run.stderr, name).not.toContain(e.DASTAR_KEY);
    }
  });

  it("is one file that inlines the workspace packages and loads the SDK and openapi-fetch from its dependencies", () => {
    const text = readFileSync(BUNDLE, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(text).not.toMatch(/from\s*["']@dastar\//);
    expect(text).toMatch(/from\s*["']@modelcontextprotocol\/server\/stdio["']/);
    expect(text).toMatch(/from\s*["']openapi-fetch["']/);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@modelcontextprotocol/server", "openapi-fetch"]);
    expect(manifest.bin).toEqual({ "dastar-mcp": "dist/dastar-mcp.js" });
    expect(manifest.files).toEqual(["dist"]);
  });
});
