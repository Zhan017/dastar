import { McpServer, fromJsonSchema, type CallToolResult } from "@modelcontextprotocol/server";
import { TOOLS, type ToolResult, type ToolSession } from "@dastar/agent-tools";

/** A tool's answer as the protocol carries it: the sentence as text, the data beside it, and the error flag only when it is one. */
export function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: result.text }],
    structuredContent: result.structured,
    ...(result.isError ? { isError: true } : {}),
  };
}

/** A server for one session that offers the four tools; the session decides what each call does. */
export function createServer(session: ToolSession, version: string): McpServer {
  const server = new McpServer({ name: "dastar", version }, { capabilities: { tools: {} } });
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: fromJsonSchema(def.inputSchema), annotations: def.annotations },
      async (args) => toCallToolResult(await session.call(def.name, args)),
    );
  }
  return server;
}
