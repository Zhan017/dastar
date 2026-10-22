import { fileURLToPath } from "node:url";
import { createApp, OPENAPI_CONFIG } from "./app.js";
import type { Deps } from "./env.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/**
 * The document `/openapi.json` serves, built without a database: the engine handle and the pool are proxies that throw on any
 * use, so building the app proves that registering the routes reads neither.
 */
export function openApiDocument(): ReturnType<ReturnType<typeof createApp>["getOpenAPIDocument"]> {
  const unused = new Proxy({}, { get: (_target, prop) => { throw new Error(`the OpenAPI document is built without a database (read ${String(prop)})`); } });
  const app = createApp({ dastar: unused as Deps["dastar"], pool: unused as Deps["pool"], migrationsDir: MIGRATIONS, log: () => undefined });
  return app.getOpenAPIDocument(OPENAPI_CONFIG);
}

/** The exact text of the committed apps/api/openapi.json. */
export function openApiText(): string {
  return `${JSON.stringify(openApiDocument(), null, 2)}\n`;
}
