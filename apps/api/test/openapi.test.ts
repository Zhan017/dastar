import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { makeApi } from "./helpers.js";

type Operation = { security?: Record<string, string[]>[]; responses: Record<string, unknown> };
type Doc = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown> } };

describe("OpenAPI document", () => {
  let conn: Conn; let api: ReturnType<typeof makeApi>; let doc: Doc;
  beforeAll(async () => {
    conn = await cloneDatabase("api_openapi_test");
    api = makeApi(conn);
    doc = await (await api.app.request("/openapi.json")).json() as Doc;
  });
  afterAll(async () => { await api.close(); await dropDatabase("api_openapi_test"); });

  it("lists exactly the implemented routes", () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/health/live", "/health/ready", "/v1/reservations/{id}", "/v1/reservations/{id}/cancel",
      "/v1/reservations/{id}/confirm", "/v1/reservations/{id}/confirm-token", "/v1/venues/{id}/holds",
    ]);
  });

  it("requires a bearer key on every v1 route, and makes it optional only on confirm", () => {
    expect(doc.paths["/v1/venues/{id}/holds"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}"]!.get!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/cancel"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/confirm-token"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/confirm"]!.post!.security).toEqual([{ Bearer: [] }, {}]);
    expect(doc.paths["/health/live"]!.get!.security).toBeUndefined();
  });

  it("declares the problem responses and the shared schemas", () => {
    expect(Object.keys(doc.paths["/v1/venues/{id}/holds"]!.post!.responses).sort()).toEqual(["201", "400", "401", "403", "404", "409", "422", "429", "500", "503"]);
    for (const name of ["Problem", "Receipt", "HoldRequest", "HoldResponse", "Reservation", "CancelRequest", "ConfirmRequest", "ConfirmTokenResponse"]) {
      expect(Object.keys(doc.components.schemas)).toContain(name);
    }
  });
});
