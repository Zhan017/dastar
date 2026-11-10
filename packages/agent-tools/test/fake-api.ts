import { createDastarClient, type DastarClient } from "@dastar/client";

export type Seen = { method: string; path: string; key: string | null; body: unknown };
/** A scripted answer: a response, an error the fetch rejects with, or "hang" until the request's signal aborts. */
export type Reply = Response | Error | "hang";

/** A client whose fetch answers from a script in order and records every request; an unscripted request fails the test. */
export function fakeApi(...script: Reply[]): { client: DastarClient; seen: Seen[] } {
  const queue = [...script];
  const seen: Seen[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const text = await request.text();
    seen.push({ method: request.method, path: new URL(request.url).pathname, key: request.headers.get("idempotency-key"), body: text === "" ? undefined : JSON.parse(text) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted request ${request.method} ${request.url}`);
    if (next === "hang") return new Promise<Response>((_, reject) => { request.signal.addEventListener("abort", () => { reject(request.signal.reason); }); });
    if (next instanceof Error) throw next;
    return next;
  };
  return { client: createDastarClient({ baseUrl: "http://dastar.test", key: "k", fetch }), seen };
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" } });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  json(status, { type: `https://dastar.dev/errors/${code}`, title: code.replaceAll("_", " "), status, code, detail: code.replaceAll("_", " "), trace_id: "t-1", ...extra });
