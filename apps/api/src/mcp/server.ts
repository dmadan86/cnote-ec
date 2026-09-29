import { DomainError } from "@cnote/core";
import { hasScope, type ApiPrincipal } from "@cnote/developer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { API_VERSION } from "../env";
import { toErrorResponse } from "../lib/errors";
import type { AppEnv } from "../types";
import { TOOLS } from "./tools";

const INSTRUCTIONS =
  "Tools for the cnote B2B marketplace (Indian MSMEs). Money is integer paise (INR). Search ranks by relevance x seller trust, never paid tier. " +
  "Enquiries are intent-scored and matched exclusively to at most N sellers. Accepting a lead consumes 1 credit. Reviews are moderated before they are public. " +
  "Only the tools your API key's scopes allow are listed; you act only within your key's business. Ask the human before any action that spends credits or sends messages/quotes.";

/** A server per request (stateless) exposing only the tools the key's scopes allow. */
export function buildMcpServer(principal: ApiPrincipal, requestId: string): McpServer {
  const server = new McpServer({ name: "cnote", version: API_VERSION }, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    if (!hasScope(principal, t.scope)) continue;
    server.registerTool(
      t.name,
      { title: t.title, description: `${t.description} [scope: ${t.scope}]`, inputSchema: t.input, annotations: t.annotations },
      (async (args: never) => {
        try {
          const result = await t.run(principal, args);
          const structured = Array.isArray(result) ? { items: result } : (result as Record<string, unknown>);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: structured };
        } catch (err) {
          // Tool-level failure: the agent should see the reason (e.g. insufficient_credits), not a protocol error.
          const { body } = toErrorResponse(err, requestId);
          const message = err instanceof DomainError || body.error.code !== "internal" ? body.error.message : `Internal error (request ${requestId})`;
          if (body.error.code === "internal") console.error("mcp tool failed", t.name, err);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: body.error.code, message } }) }] };
        }
      }) as never,
    );
  }
  return server;
}

export async function handleMcp(c: Context<AppEnv>): Promise<Response> {
  const server = buildMcpServer(c.get("principal"), c.get("requestId"));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    // Stateless: nothing survives the request (responses are plain JSON, so nothing is still streaming).
    void server.close().catch(() => undefined);
  }
}
