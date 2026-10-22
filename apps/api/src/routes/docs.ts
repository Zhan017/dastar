import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env.js";

// Swagger UI from the installed swagger-ui-dist; resolved, never imported, because its entry point loads the browser bundle
const resolve = createRequire(import.meta.url).resolve;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dastar reference API</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/docs/swagger-ui.css">
</head>
<body>
<div id="ui"></div>
<script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/init.js"></script>
</body>
</html>
`;

// the apis preset alone: no top bar with a box for another document's URL, and no validator badge, which calls a third party
const INIT = `window.addEventListener("load", function () {
  window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui", layout: "BaseLayout", presets: [SwaggerUIBundle.presets.apis], validatorUrl: null });
});
`;

// scripts, styles and requests from this origin only; images also as data: URLs, which the stylesheet uses
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const VENDOR = { "swagger-ui.css": "text/css; charset=utf-8", "swagger-ui-bundle.js": "text/javascript; charset=utf-8" } as const;
type VendorFile = keyof typeof VENDOR;
const loaded = new Map<VendorFile, Promise<string>>();

/** A vendor file, read on first request and kept; a failed read is forgotten, so the next request tries again. */
function vendor(name: VendorFile): Promise<string> {
  let file = loaded.get(name);
  if (file === undefined) {
    file = readFile(resolve(`swagger-ui-dist/${name}`), "utf8");
    file.catch(() => { loaded.delete(name); });
    loaded.set(name, file);
  }
  return file;
}

/** The docs page and its files; plain routes, so they are not part of the document they show. */
export function register(app: OpenAPIHono<Env>): void {
  const nosniff = { "x-content-type-options": "nosniff" };
  app.get("/docs", (c) => c.body(PAGE, 200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, ...nosniff }));
  app.get("/docs/init.js", (c) => c.body(INIT, 200, { "content-type": "text/javascript; charset=utf-8", ...nosniff }));
  for (const name of Object.keys(VENDOR) as VendorFile[]) {
    app.get(`/docs/${name}`, async (c) => c.body(await vendor(name), 200, { "content-type": VENDOR[name], ...nosniff }));
  }
}
