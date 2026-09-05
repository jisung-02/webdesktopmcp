/**
 * Local MCP server for desktop hosts.
 *
 * Exposes the app's webview-registered WebMCP tools to any MCP client via a
 * loopback-only Streamable-HTTP endpoint guarded by a bearer token. The stdio
 * shim (`@webdesktopmcp/cli`) connects to this endpoint for stdio-only
 * clients such as Claude Desktop.
 *
 * Uses the low-level MCP `Server` class so tool `inputSchema`s pass through
 * as raw JSON Schema (the MCP wire format) without a zod conversion layer —
 * page-declared schemas must reach agents verbatim.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { PROTOCOL_VERSION, type RegisteredToolInfo } from "@webdesktopmcp/protocol";
import { ToolRegistry, type HostAdapter } from "./registry.js";

export interface LocalServerOptions {
  appName: string;
  appVersion: string;
  registry: ToolRegistry;
  /** Port to bind on 127.0.0.1. Default: 0 (ephemeral). */
  port?: number;
  /** Bearer token. Default: generated. */
  token?: string;
  /**
   * Gate before a tool executes (e.g. a native confirmation dialog for
   * sensitive tools). Return false to refuse the call.
   */
  confirmToolCall?: (tool: RegisteredToolInfo, input: unknown) => Promise<boolean> | boolean;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface RunningLocalServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export async function startLocalMcpServer(options: LocalServerOptions): Promise<RunningLocalServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const log = options.log ?? (() => {});

  /** Tools with an explicit `exposedTo` are reserved for in-page agents. */
  const externallyVisible = (): RegisteredToolInfo[] =>
    options.registry.list().filter((t) => !t.exposedTo || t.exposedTo.length === 0);

  const buildServer = (): Server => {
    const server = new Server(
      { name: options.appName, version: options.appVersion },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: externallyVisible().map(
        (tool): McpTool => ({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as McpTool["inputSchema"],
          ...(tool.annotations
            ? {
                annotations: {
                  readOnlyHint: tool.annotations.readOnlyHint,
                },
              }
            : {}),
          _meta: {
            "webdesktopmcp/frameId": tool.frameId, "webdesktopmcp/origin": tool.origin,
            ...(tool.annotations ? { "webdesktopmcp/annotations": tool.annotations } : {}),
          },
        }),
      ),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const tool = options.registry.get(name);
      if (!tool) {
        return errorResult(`Unknown tool "${name}". It may have been unregistered by the app.`);
      }
      // Exposure is enforced on calls, not just listings: a tool reserved for
      // in-page agents via `exposedTo` must not be invocable by external
      // clients that simply read its name out of band.
      if (tool.exposedTo && tool.exposedTo.length > 0) {
        return errorResult(
          `Tool "${name}" is reserved for in-page agents (exposedTo) and is not callable by external clients.`,
        );
      }
      const input = request.params.arguments ?? {};
      if (options.confirmToolCall) {
        try {
          const allowed = await options.confirmToolCall(tool, input);
          if (!allowed) return errorResult("The user declined this tool call.");
        } catch (err) {
          return errorResult(`Confirmation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        const resultJson = await options.registry.invoke(name, input, extra.signal);
        const structured = safeParse(resultJson);
        return {
          content: [{ type: "text" as const, text: resultJson }],
          // MCP requires structuredContent to be a record; arrays and
          // primitives ride on the text content only.
          ...(isPlainRecord(structured) ? { structuredContent: structured } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("warn", `Tool "${name}" failed: ${message}`);
        return errorResult(message);
      }
    });

    return server;
  };

  const httpServer: HttpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, options, buildServer, token);
  });

  const requestedPort = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : requestedPort;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LocalServerOptions,
  buildServer: () => Server,
  token: string,
): Promise<void> {
  // `req.url` is path-only on a server socket; a fixed base is fine since we
  // only read pathname/query.
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }

  // Unauthenticated health probe so launchers/CLIs can detect a live app.
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    respondJson(res, 200, {
      app: options.appName,
      version: options.appVersion,
      protocolVersion: PROTOCOL_VERSION,
    });
    return;
  }

  const auth = req.headers.authorization ?? "";
  if (!constantTimeEquals(auth, `Bearer ${token}`)) {
    respondJson(res, 401, {
      error: "Unauthorized. Pass the bearer token from the app's registry entry.",
    });
    return;
  }

  if (req.method !== "POST") {
    // Stateless JSON mode: no SSE streams, no session termination.
    respondJson(res, 405, { error: "POST JSON-RPC to /mcp." });
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    respondJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  // Stateless pattern from the MCP SDK docs: fresh server + transport per request.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

export { ToolRegistry } from "./registry.js";
export type { HostAdapter } from "./registry.js";

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
