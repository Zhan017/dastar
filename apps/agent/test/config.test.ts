import { describe, it, expect } from "vitest";
import { readAgentConfig } from "../src/config.js";

const VENUE = "0199a000-0000-7000-8000-000000000001";
const KEY_ID = "0199a000-0000-7000-8000-0000000000b1";
const TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

const GOOD = {
  DATABASE_URL: "postgres://agent:secret@127.0.0.1:5432/dastar",
  DASTAR_URL: "http://127.0.0.1:8080/dastar/",
  DASTAR_VENUE_ID: VENUE.toUpperCase(),
  AGENT_KEY: "dsk_agent",
  AGENT_KEY_ID: KEY_ID.toUpperCase(),
  DEMO_CONFIRM_KEY: "dsk_confirm",
  DASTAR_TOKEN_KEY: TOKEN_KEY,
  ANTHROPIC_API_KEY: "sk-ant-test",
};

const line = (text: string) => ({ ok: false, line: text });

describe("readAgentConfig", () => {
  it("reads the eight settings and the defaults", () => {
    expect(readAgentConfig(GOOD)).toEqual({
      ok: true,
      config: {
        databaseUrl: GOOD.DATABASE_URL,
        dastarUrl: GOOD.DASTAR_URL,
        venueId: VENUE,
        agentKey: "dsk_agent",
        agentKeyId: KEY_ID,
        demoConfirmKey: "dsk_confirm",
        tokenKey: Buffer.alloc(32, 7),
        anthropicApiKey: "sk-ant-test",
        model: "claude-opus-5-5",
        effort: "medium",
        host: "127.0.0.1",
        port: 8081,
      },
    });
    const read = readAgentConfig(GOOD);
    if (read.ok) expect(read.config.tokenKey.length).toBe(32);
  });

  it("reads the optional settings when they are given, trimmed", () => {
    const read = readAgentConfig({ ...GOOD, AGENT_MODEL: " claude-sonnet-5-5 ", AGENT_EFFORT: " xhigh ", AGENT_HOST: " 0.0.0.0 ", AGENT_PORT: " 0 " });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.config).toMatchObject({ model: "claude-sonnet-5-5", effort: "xhigh", host: "0.0.0.0", port: 0 });
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(readAgentConfig({ ...GOOD, AGENT_EFFORT: effort }).ok, effort).toBe(true);
    }
  });

  it("names every missing setting", () => {
    const rest = Object.fromEntries(Object.entries(GOOD).filter(([name]) => name !== "DASTAR_URL" && name !== "AGENT_KEY"));
    expect(readAgentConfig(rest)).toEqual(line(
      "set DATABASE_URL, DASTAR_URL, DASTAR_VENUE_ID, AGENT_KEY, AGENT_KEY_ID, DEMO_CONFIRM_KEY, DASTAR_TOKEN_KEY and ANTHROPIC_API_KEY; missing: DASTAR_URL, AGENT_KEY",
    ));
    expect(readAgentConfig({ ...rest, DASTAR_URL: " ", AGENT_KEY: "\n" })).toEqual(readAgentConfig(rest));
  });

  it("refuses bad values with one line each", () => {
    const bad = (over: Record<string, string>, text: string) => expect(readAgentConfig({ ...GOOD, ...over }), JSON.stringify(over)).toEqual(line(text));

    bad({ DASTAR_URL: "ftp://x" }, "DASTAR_URL must be an http or https URL");
    bad({ DASTAR_URL: "http://agent:hunter2@127.0.0.1:8080" }, "DASTAR_URL must not include a user name or password");
    bad({ DASTAR_VENUE_ID: "v" }, "DASTAR_VENUE_ID must be a uuid");
    bad({ AGENT_KEY_ID: "k" }, "AGENT_KEY_ID must be a uuid");
    bad({ AGENT_KEY: "dsk agent" }, "AGENT_KEY must contain only visible ASCII characters");
    bad({ DEMO_CONFIRM_KEY: "dsk confirm" }, "DEMO_CONFIRM_KEY must contain only visible ASCII characters");
    bad({ ANTHROPIC_API_KEY: "sk ant" }, "ANTHROPIC_API_KEY must contain only visible ASCII characters");
    bad({ DEMO_CONFIRM_KEY: GOOD.AGENT_KEY }, "AGENT_KEY and DEMO_CONFIRM_KEY must be different keys");
    bad({ DASTAR_TOKEN_KEY: Buffer.alloc(31, 7).toString("base64") }, "DASTAR_TOKEN_KEY must be 32 bytes in base64");
    bad({ DASTAR_TOKEN_KEY: Buffer.alloc(33, 7).toString("base64") }, "DASTAR_TOKEN_KEY must be 32 bytes in base64");
    bad({ DASTAR_TOKEN_KEY: "not base64!" }, "DASTAR_TOKEN_KEY must be 32 bytes in base64");
    // a character outside the alphabet would be skipped by the decoder, so the text is checked before it is decoded
    bad({ DASTAR_TOKEN_KEY: `${TOKEN_KEY.slice(0, 10)}!${TOKEN_KEY.slice(10)}` }, "DASTAR_TOKEN_KEY must be 32 bytes in base64");
    bad({ AGENT_EFFORT: "huge" }, "AGENT_EFFORT must be one of low, medium, high, xhigh, max");
    bad({ AGENT_PORT: "70000" }, "AGENT_PORT must be an integer from 0 to 65535");
    bad({ AGENT_PORT: "x" }, "AGENT_PORT must be an integer from 0 to 65535");
    bad({ AGENT_PORT: "80.5" }, "AGENT_PORT must be an integer from 0 to 65535");
    bad({ AGENT_PORT: "-1" }, "AGENT_PORT must be an integer from 0 to 65535");
  });

  it("falls back to the default for a blank optional setting", () => {
    const read = readAgentConfig({ ...GOOD, AGENT_MODEL: " ", AGENT_EFFORT: "", AGENT_HOST: "\n", AGENT_PORT: " " });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.config).toMatchObject({ model: "claude-opus-5-5", effort: "medium", host: "127.0.0.1", port: 8081 });
  });
});
