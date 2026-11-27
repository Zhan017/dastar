import { describe, it, expect } from "vitest";
import { readJudgeConfig } from "../src/judge/config.js";

const GOOD = {
  DATABASE_URL: "postgres://judge:secret@127.0.0.1:5432/dastar",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

const line = (text: string) => ({ ok: false, line: text });

describe("readJudgeConfig", () => {
  it("reads the two settings and the defaults", () => {
    expect(readJudgeConfig(GOOD)).toEqual({
      ok: true,
      config: {
        databaseUrl: GOOD.DATABASE_URL,
        anthropicApiKey: "sk-ant-test",
        model: "claude-opus-5-5",
        effort: "medium",
        everyMs: 10_000,
        limit: 10,
        dailyCalls: 500,
      },
    });
  });

  it("reads the optional settings when they are given, trimmed", () => {
    const read = readJudgeConfig({
      ...GOOD, JUDGE_MODEL: " claude-sonnet-5-5 ", JUDGE_EFFORT: " xhigh ", JUDGE_EVERY_MS: " 2500 ", JUDGE_LIMIT: "3", JUDGE_DAILY_CALLS: " 40\n",
    });
    expect(read).toEqual({
      ok: true,
      config: {
        databaseUrl: GOOD.DATABASE_URL, anthropicApiKey: "sk-ant-test", model: "claude-sonnet-5-5", effort: "xhigh", everyMs: 2500, limit: 3, dailyCalls: 40,
      },
    });
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(readJudgeConfig({ ...GOOD, JUDGE_EFFORT: effort }).ok, effort).toBe(true);
    }
  });

  it("names every missing setting", () => {
    expect(readJudgeConfig({})).toEqual(line("set DATABASE_URL and ANTHROPIC_API_KEY; missing: DATABASE_URL, ANTHROPIC_API_KEY"));
    expect(readJudgeConfig({ ANTHROPIC_API_KEY: GOOD.ANTHROPIC_API_KEY })).toEqual(line("set DATABASE_URL and ANTHROPIC_API_KEY; missing: DATABASE_URL"));
    expect(readJudgeConfig({ DATABASE_URL: GOOD.DATABASE_URL })).toEqual(line("set DATABASE_URL and ANTHROPIC_API_KEY; missing: ANTHROPIC_API_KEY"));
    expect(readJudgeConfig({ DATABASE_URL: " ", ANTHROPIC_API_KEY: "\n" })).toEqual(readJudgeConfig({}));
  });

  it("refuses an API key that is not visible ASCII only", () => {
    for (const key of ["sk ant", "sk-ant-é", "sk-ant\ttest", "sk-–ant"]) {
      expect(readJudgeConfig({ ...GOOD, ANTHROPIC_API_KEY: key }), JSON.stringify(key)).toEqual(line("ANTHROPIC_API_KEY must contain only visible ASCII characters"));
    }
  });

  it("refuses an effort that is not one of the five", () => {
    for (const effort of ["huge", "MEDIUM", "none"]) {
      expect(readJudgeConfig({ ...GOOD, JUDGE_EFFORT: effort }), effort).toEqual(line("JUDGE_EFFORT must be one of low, medium, high, xhigh, max"));
    }
  });

  it("refuses a count that is not a positive integer", () => {
    for (const name of ["JUDGE_EVERY_MS", "JUDGE_LIMIT", "JUDGE_DAILY_CALLS"]) {
      for (const value of ["0", "-1", "1.5", "x", "1e3", "0x10", "+5", "99999999999999999999"]) {
        expect(readJudgeConfig({ ...GOOD, [name]: value }), `${name}=${value}`).toEqual(line(`${name} must be a positive integer`));
      }
    }
  });

  it("falls back to the default for a blank optional setting", () => {
    const read = readJudgeConfig({
      ...GOOD, JUDGE_MODEL: " ", JUDGE_EFFORT: "", JUDGE_EVERY_MS: "\n", JUDGE_LIMIT: " ", JUDGE_DAILY_CALLS: "",
    });
    expect(read).toEqual(readJudgeConfig(GOOD));
  });
});
