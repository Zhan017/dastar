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
      "/admin/venues/{id}/blackouts", "/admin/venues/{id}/blackouts/{blackoutId}", "/admin/venues/{id}/combos", "/admin/venues/{id}/combos/{comboId}",
      "/admin/venues/{id}/schedules", "/admin/venues/{id}/schedules/{scheduleId}", "/admin/venues/{id}/units", "/admin/venues/{id}/units/{unitId}",
      "/health/live", "/health/ready", "/v1/reservations/{id}", "/v1/reservations/{id}/cancel", "/v1/reservations/{id}/complete",
      "/v1/reservations/{id}/confirm", "/v1/reservations/{id}/confirm-token", "/v1/reservations/{id}/seat", "/v1/venues/{id}/availability",
      "/v1/venues/{id}/holds",
    ]);
  });

  it("requires a bearer key on every v1 route, and makes it optional only on confirm", () => {
    expect(doc.paths["/v1/venues/{id}/holds"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/venues/{id}/holds"]!.get!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/venues/{id}/availability"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}"]!.get!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/cancel"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/seat"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/complete"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/confirm-token"]!.post!.security).toEqual([{ Bearer: [] }]);
    expect(doc.paths["/v1/reservations/{id}/confirm"]!.post!.security).toEqual([{ Bearer: [] }, {}]);
    expect(doc.paths["/health/live"]!.get!.security).toBeUndefined();
  });

  it("requires a bearer key on every admin operation, and declares the problem responses on each", () => {
    const operations = Object.entries(doc.paths)
      .filter(([path]) => path.startsWith("/admin/"))
      .flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ name: `${method} ${path}`, op })));
    expect(operations.map((o) => o.name).sort()).toEqual([
      "get /admin/venues/{id}/blackouts", "get /admin/venues/{id}/combos", "get /admin/venues/{id}/schedules", "get /admin/venues/{id}/units",
      "patch /admin/venues/{id}/blackouts/{blackoutId}", "patch /admin/venues/{id}/combos/{comboId}", "patch /admin/venues/{id}/schedules/{scheduleId}",
      "patch /admin/venues/{id}/units/{unitId}",
      "post /admin/venues/{id}/blackouts", "post /admin/venues/{id}/combos", "post /admin/venues/{id}/schedules", "post /admin/venues/{id}/units",
    ]);
    for (const { name, op } of operations) {
      expect(op.security, name).toEqual([{ Bearer: [] }]);
      expect(Object.keys(op.responses), name).toEqual(expect.arrayContaining(["400", "401", "403", "404", "409", "422"]));
    }
  });

  it("declares the problem responses and the shared schemas", () => {
    expect(Object.keys(doc.paths["/v1/venues/{id}/holds"]!.post!.responses).sort()).toEqual(["201", "400", "401", "403", "404", "409", "422", "429", "500", "503"]);
    for (const op of [doc.paths["/v1/venues/{id}/holds"]!.get!, doc.paths["/v1/venues/{id}/availability"]!.post!, doc.paths["/v1/reservations/{id}/seat"]!.post!, doc.paths["/v1/reservations/{id}/complete"]!.post!]) {
      expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "404", "409", "422", "429", "500", "503"]);
    }
    for (const name of ["Problem", "Receipt", "HoldRequest", "HoldResponse", "HoldList", "AvailabilityRequest", "Availability", "Reservation", "CancelRequest", "ConfirmRequest", "ConfirmTokenResponse", "StatusChangeRequest",
      "CreateUnitRequest", "UpdateUnitRequest", "UnitList", "UnitResponse", "UnitChange", "CreateComboRequest", "UpdateComboRequest", "ComboList",
      "CreateScheduleRequest", "UpdateScheduleRequest", "ScheduleList", "CreateBlackoutRequest", "UpdateBlackoutRequest", "BlackoutList", "BlackoutChange"]) {
      expect(Object.keys(doc.components.schemas)).toContain(name);
    }
  });
});
