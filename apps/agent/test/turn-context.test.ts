import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { makeApi } from "../../api/test/helpers.js";
import { loadPrompt } from "../src/prompt.js";
import { runTurn } from "../src/turn.js";
import { replyWith, scripted } from "./fake-provider.js";

describe("the context of a turn", () => {
  const NAME = "agent_turn_context_test";
  const BASE = "http://dastar.test";
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let agent: (sessionId: string) => DastarClient; let demo: DastarClient;
  let agentKeyId = "";

  beforeAll(async () => {
    conn = await cloneDatabase(NAME);
    owner = await connect(conn.owner);
    // the setting is read by each connection made after this, so it comes before the API's pool opens
    await owner.query(`alter database "${NAME}" set dastar.now = '2064-01-07T16:00:00Z'`);
    seed = await seedVenue(owner);
    api = makeApi(conn);
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    const agentKey = await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "cancel"], venueIds: [seed.venue] });
    const demoKey = await createKey(api.pool, { label: "demo", capabilities: ["read", "confirm"], venueIds: [seed.venue] });
    agentKeyId = agentKey.id;
    agent = (sessionId) => createDastarClient({ baseUrl: BASE, key: agentKey.key, session: sessionId, fetch });
    demo = createDastarClient({ baseUrl: BASE, key: demoKey.key, fetch });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase(NAME); });

  it("the context carries the database's time and the venue's zone and name", async () => {
    const venue = await api.dastar.venueProfile(seed.venue);
    if (venue === null) throw new Error("the venue was not found");
    const provider = scripted(replyWith({ message: "Hello.", claims: [] }));
    const out = await runTurn(
      { dastar: api.dastar, provider, agentClient: agent, demoClient: demo, venue, agentKeyId, tokenKey: randomBytes(32), prompt: loadPrompt() },
      { message: "Hello there" },
    );
    expect(out.ok).toBe(true);

    expect(provider.requests[0]!.messages.slice(-2)).toEqual([
      { role: "user", text: "Hello there" },
      {
        role: "operator",
        text:
          "The time now is 2064-01-07T16:00:00.000Z (UTC). At the venue it is Monday 2064-01-07 17:00, " +
          "time zone Europe/Berlin (UTC+01:00). The venue is Test.",
      },
    ]);
  });
});
