import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

type Rule = { name: string; from: { path?: string; pathNot?: string }; to: { path: string } };

const config = createRequire(import.meta.url)("../../../.dependency-cruiser.cjs") as { forbidden: Rule[] };

const rule = (name: string): Rule => {
  const found = config.forbidden.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no rule named ${name}`);
  return found;
};

describe("the package boundaries of the agent", () => {
  it("the agent may not import the API, the worker, the harness or the MCP server, and nothing imports the agent", () => {
    const agent = rule("agent-on-the-contract-and-engine");
    expect(new RegExp(agent.from.path ?? "").test("apps/agent/src/turn.ts")).toBe(true);
    for (const p of ["apps/api/src/app.ts", "packages/mcp/src/main.ts", "packages/worker/src/worker.ts", "apps/harness/src/cli.ts"]) {
      expect(new RegExp(agent.to.path).test(p), p).toBe(true);
    }
    for (const p of ["packages/db/src/index.ts", "packages/client/src/index.ts", "packages/agent-tools/src/index.ts"]) {
      expect(new RegExp(agent.to.path).test(p), p).toBe(false);
    }

    const nothing = rule("nothing-imports-the-agent");
    const notAgent = new RegExp(nothing.from.pathNot ?? "");
    expect(notAgent.test("apps/api/src/app.ts")).toBe(false);
    expect(notAgent.test("apps/agent/src/x.ts")).toBe(true);
    expect(new RegExp(nothing.to.path).test("apps/agent/src/turn.ts")).toBe(true);
  });
});
