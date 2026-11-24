import { describe, it, expect } from "vitest";
import { checkConfirmKey, checkCredential, keyCommand } from "../src/index.js";
import { fakeApi, json, problem } from "./fake-api.js";

const VENUE = "0199a000-0000-7000-8000-000000000001";
const TARGET = { url: "http://dastar.test", venueId: VENUE };
const NO_RESERVATION = "00000000-0000-0000-0000-000000000000";
const DEMO_FIX = `pnpm keys:create --label demo --capabilities read,confirm --venues ${VENUE}`;

describe("keyCommand", () => {
  it("defaults to the MCP server's label and capabilities", () => {
    expect(keyCommand(VENUE)).toBe(`pnpm keys:create --label mcp --capabilities read,hold,cancel --venues ${VENUE}`);
  });

  it("takes a label and capabilities", () => {
    expect(keyCommand(VENUE, "demo", "read,confirm")).toBe(DEMO_FIX);
  });
});

describe("checkConfirmKey", () => {
  it("passes a key that reads holds and is told 404 for the confirm token", async () => {
    const api = fakeApi(json(200, { holds: [] }), problem(404, "not_found"));
    expect(await checkConfirmKey(api.client, TARGET)).toBeNull();
    expect(api.seen.map((x) => [x.method, x.path])).toEqual([
      ["GET", `/v1/venues/${VENUE}/holds`],
      ["POST", `/v1/reservations/${NO_RESERVATION}/confirm-token`],
    ]);
  });

  it("refuses a key that cannot confirm, naming the fix", async () => {
    const api = fakeApi(json(200, { holds: [] }), problem(403, "forbidden"));
    expect(await checkConfirmKey(api.client, { ...TARGET, fix: DEMO_FIX }))
      .toBe(`the key cannot confirm reservations, and DEMO_CONFIRM_KEY must; create one with: ${DEMO_FIX}`);
    expect(api.seen).toHaveLength(2);
  });

  it("refuses a key that cannot read the venue's holds", async () => {
    const api = fakeApi(problem(403, "forbidden"));
    expect(await checkConfirmKey(api.client, { ...TARGET, fix: DEMO_FIX })).toBe(`the key lacks the read capability; create one with: ${DEMO_FIX}`);
    expect(api.seen).toHaveLength(1);
  });
});

describe("the fix a refusal names", () => {
  it("is the given one, and the default is the MCP server's command", async () => {
    // A key with the admin capability: the holds probe passes, the confirm-token probe is refused as it should be, the key listing is answered.
    const admin = (): ReturnType<typeof fakeApi> => fakeApi(json(200, { holds: [] }), problem(403, "forbidden"), json(200, { keys: [] }));
    const byDefault = await checkCredential(admin().client, TARGET);
    expect(byDefault).toBe(`the key has the admin capability, and this server takes only keys without it; create one with: ${keyCommand(VENUE)}`);
    const given = await checkCredential(admin().client, { ...TARGET, fix: "X" });
    expect(given).toBe("the key has the admin capability, and this server takes only keys without it; create one with: X");
  });
});
