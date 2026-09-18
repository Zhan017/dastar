import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";

const live = createRoute({
  method: "get",
  path: "/health/live",
  responses: { 200: { description: "The process is up", content: { "application/json": { schema: z.object({ status: z.literal("live") }) } } } },
});

export function register(app: OpenAPIHono<Env>, _deps: Deps): void {
  app.openapi(live, (c) => c.json({ status: "live" as const }, 200));
}
