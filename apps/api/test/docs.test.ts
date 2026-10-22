import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/env.js";
import { MIGRATIONS } from "./helpers.js";

describe("the docs page", () => {
  // the page and its files read neither the engine nor the pool
  const app = createApp({ dastar: {} as Deps["dastar"], pool: {} as Deps["pool"], migrationsDir: MIGRATIONS, log: () => undefined });

  it("is served with a policy that admits this origin only", async () => {
    const r = await app.request("/docs");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await r.text();
    expect([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1])).toEqual(["data:,", "/docs/swagger-ui.css", "/docs/swagger-ui-bundle.js", "/docs/init.js"]);
    expect(html).not.toMatch(/https?:/);
    expect(html).not.toMatch(/<script>|<style|style=/);
  });

  it("starts Swagger UI on the served document, without the top bar or the validator", async () => {
    const r = await app.request("/docs/init.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const js = await r.text();
    expect(js).toContain('url: "/openapi.json"');
    expect(js).toContain('layout: "BaseLayout"');
    expect(js).toContain("presets: [SwaggerUIBundle.presets.apis]");
    expect(js).toContain("validatorUrl: null");
    expect(js).not.toMatch(/Standalone|https?:/);
  });

  it("serves the stylesheet and the bundle from the installed package", async () => {
    const files = [["/docs/swagger-ui.css", "text/css; charset=utf-8", 100_000], ["/docs/swagger-ui-bundle.js", "text/javascript; charset=utf-8", 1_000_000]] as const;
    for (const [path, type, size] of files) {
      const r = await app.request(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type"), path).toBe(type);
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect((await r.text()).length, path).toBeGreaterThan(size);
    }
  });

  it("serves nothing else of the package", async () => {
    for (const path of ["/docs/", "/docs/index.html", "/docs/swagger-initializer.js", "/docs/swagger-ui-bundle.js.map", "/docs/package.json"]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});
