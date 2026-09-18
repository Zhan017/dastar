import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { makeApi } from "./helpers.js";

describe("app shell", () => {
  let conn: Conn; let api: ReturnType<typeof makeApi>;
  beforeAll(async () => { conn = await cloneDatabase("api_app_test"); api = makeApi(conn); });
  afterAll(async () => { await api.close(); await dropDatabase("api_app_test"); });

  it("answers liveness and echoes or generates a trace id", async () => {
    const r = await api.app.request("/health/live", { headers: { "x-trace-id": "trace-1" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "live" });
    expect(r.headers.get("x-trace-id")).toBe("trace-1");
    const g = await api.app.request("/health/live", { headers: { "x-trace-id": "bad trace id with spaces" } });
    expect(g.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("renders an unknown route as a 404 problem", async () => {
    const r = await api.app.request("/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("application/problem+json");
    expect(await r.json()).toMatchObject({ type: "https://dastar.dev/errors/not_found", code: "not_found", status: 404 });
  });

  it("logs one entry per request without bodies", async () => {
    api.lines.length = 0;
    await api.app.request("/health/live");
    expect(api.lines).toHaveLength(1);
    expect(Object.keys(api.lines[0]!).sort()).toEqual(["duration_ms", "key_id", "method", "path", "status", "trace_id", "ts"]);
    expect(api.lines[0]).toMatchObject({ method: "GET", path: "/health/live", status: 200, key_id: null });
  });

  it("serves an OpenAPI document with the bearer scheme", async () => {
    const r = await api.app.request("/openapi.json");
    expect(r.status).toBe(200);
    const doc = await r.json() as { openapi: string; paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } };
    expect(doc.openapi).toBe("3.0.0");
    expect(Object.keys(doc.paths)).toContain("/health/live");
    expect(doc.components.securitySchemes).toEqual({ Bearer: { type: "http", scheme: "bearer" } });
  });
});
