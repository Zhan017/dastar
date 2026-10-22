import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./schema.js";

export type { components, paths } from "./schema.js";
/** The body of every error response: RFC 9457 Problem Details carrying the engine's error code. */
export type Problem = components["schemas"]["Problem"];
export type DastarClient = Client<paths>;

export type DastarClientOptions = {
  /** Where the reference API listens, such as http://127.0.0.1:8080. */
  baseUrl: string;
  /** An API key, sent as a bearer token on every request; without one, or with an empty one, a client can still confirm with a token. */
  key?: string | undefined;
  /** A fetch to use instead of the global one, such as an in-process app's request function. */
  fetch?: ClientOptions["fetch"];
};

/** A client typed by the committed OpenAPI document: each call names a path as the document writes it and returns `{ data, error, response }`. */
export function createDastarClient(opts: DastarClientOptions): DastarClient {
  return createClient<paths>({
    baseUrl: opts.baseUrl,
    ...(opts.key !== undefined && opts.key !== "" ? { headers: { authorization: `Bearer ${opts.key}` } } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}
