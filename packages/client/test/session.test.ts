import { describe, it, expect } from "vitest";
import { createDastarClient } from "../src/index.js";

const VENUE = "0199a000-0000-7000-8000-000000000001";
const SESSION = "0199a000-0000-7000-8000-0000000000aa";

type Seen = { method: string; session: string | null; authorization: string | null };

/** A client whose requests are answered by a fake fetch that records the headers each one carried. */
function recording(opts: { key?: string; session?: string }): { seen: Seen[]; send: () => Promise<void> } {
  const seen: Seen[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    seen.push({ method: request.method, session: request.headers.get("dastar-session"), authorization: request.headers.get("authorization") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createDastarClient({ baseUrl: "http://dastar.test", fetch, ...opts });
  return {
    seen,
    send: async () => {
      await client.GET("/v1/venues/{id}/holds", { params: { path: { id: VENUE } } });
      await client.POST("/v1/venues/{id}/availability", {
        params: { path: { id: VENUE } },
        body: { party_size: 2, from: "2064-01-07T00:00:00Z", to: "2064-01-08T00:00:00Z" },
      });
    },
  };
}

describe("the client's session option", () => {
  it("sends dastar-session on every request when a session is set, and none otherwise", async () => {
    const withSession = recording({ key: "k", session: SESSION });
    await withSession.send();
    expect(withSession.seen).toEqual([
      { method: "GET", session: SESSION, authorization: "Bearer k" },
      { method: "POST", session: SESSION, authorization: "Bearer k" },
    ]);

    const empty = recording({ key: "k", session: "" });
    await empty.send();
    expect(empty.seen).toEqual([
      { method: "GET", session: null, authorization: "Bearer k" },
      { method: "POST", session: null, authorization: "Bearer k" },
    ]);

    const none = recording({ key: "k" });
    await none.send();
    expect(none.seen).toEqual([
      { method: "GET", session: null, authorization: "Bearer k" },
      { method: "POST", session: null, authorization: "Bearer k" },
    ]);
  });

  it("sends the session without an authorization header when there is no key, and no header at all when there is neither", async () => {
    const sessionOnly = recording({ session: SESSION });
    await sessionOnly.send();
    expect(sessionOnly.seen.map((s) => [s.session, s.authorization])).toEqual([[SESSION, null], [SESSION, null]]);

    const neither = recording({ key: "", session: "" });
    await neither.send();
    expect(neither.seen.map((s) => [s.session, s.authorization])).toEqual([[null, null], [null, null]]);
  });
});
