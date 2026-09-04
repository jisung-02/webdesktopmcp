#!/usr/bin/env node
/**
 * `webdesktopmcp connect --app <name>`
 *
 * stdio ⇄ Streamable-HTTP shim. Point your MCP client at this command; it
 * finds the running desktop app via ~/.webdesktopmcp/registry.json and
 * proxies tools/list + tools/call to the app's loopback MCP endpoint.
 *
 * Claude Desktop config example:
 * {
 *   "mcpServers": {
 *     "my-app": {
 *       "command": "npx",
 *       "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"]
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readAppEntry } from "@webdesktopmcp/server";
import type { AppRegistryEntry } from "@webdesktopmcp/protocol";
import fs from "node:fs";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app") args.app = argv[++i] ?? "";
    else if (arg === "--registry") args.registry = argv[++i] ?? "";
    else if (arg === "--wait") args.wait = argv[++i] ?? "5";
  }
  return args;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // alive but owned by another user
  }
}

async function connectUpstream(entry: AppRegistryEntry): Promise<Client> {
  const client = new Client({ name: "webdesktopmcp-cli", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: { authorization: `Bearer ${entry.token}` } },
    }),
  );
  return client;
}

async function findApp(appName: string, registryDir?: string, waitSeconds = 5): Promise<AppRegistryEntry> {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastError = `No app named "${appName}" in the registry.`;
  while (Date.now() < deadline) {
    const entry = await readAppEntry(appName, registryDir).catch(() => undefined);
    if (entry && isPidAlive(entry.pid)) return entry;
    if (entry) lastError = `App "${appName}" has a stale registry entry (pid ${entry.pid} is gone).`;
    await new Promise((r) => setTimeout(r, 400));
  }
  const dir = registryDir ?? `${process.env.HOME ?? "~"}/.webdesktopmcp`;
  try {
    const raw = JSON.parse(fs.readFileSync(`${dir}/registry.json`, "utf8")) as { apps: Record<string, unknown> };
    const known = Object.keys(raw.apps ?? {}).join(", ");
    if (known) lastError += ` Known apps: ${known}.`;
  } catch {
    lastError += ` No registry file at ${dir}/registry.json — is the app running?`;
  }
  console.error(`[webdesktopmcp] ${lastError}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "list") {
    const dir = args.registry ?? `${process.env.HOME ?? "~"}/.webdesktopmcp`;
    try {
      const raw = JSON.parse(fs.readFileSync(`${dir}/registry.json`, "utf8")) as {
        apps: Record<string, { url: string; pid: number; updatedAt: string }>;
      };
      for (const [name, app] of Object.entries(raw.apps ?? {})) {
        console.log(`${name}\t${app.url}\tpid=${app.pid}\t${app.updatedAt}`);
      }
    } catch {
      console.error("No registry file found. Is a webdesktopmcp app running?");
      process.exit(1);
    }
    return;
  }

  if (command !== "connect" && command !== "tools") {
    console.error(`Usage:
  webdesktopmcp connect --app <name> [--registry <dir>] [--wait <sec>]   stdio shim for MCP clients
  webdesktopmcp tools --app <name> [--registry <dir>]                    inspect a running app's tools
  webdesktopmcp list                                                     list running apps`);
    process.exit(command ? 1 : 0);
  }
  if (!args.app) {
    console.error("[webdesktopmcp] --app is required.");
    process.exit(1);
  }

  const entry = await findApp(args.app, args.registry, Number(args.wait ?? "5"));
  console.error(`[webdesktopmcp] Connecting to ${entry.appName} at ${entry.url} …`);

  const upstream = await connectUpstream(entry);

  if (command === "tools") {
    const { tools } = await upstream.listTools();
    if (tools.length === 0) {
      console.error(`[webdesktopmcp] ${entry.appName} has no registered tools (is the page loaded?).`);
    }
    for (const tool of tools) {
      const required = ((tool.inputSchema as { required?: string[] } | undefined)?.required ?? []).join(", ");
      console.log(`${tool.name}`);
      console.log(`  ${tool.description ?? ""}`);
      if (required) console.log(`  required: ${required}`);
    }
    await upstream.close();
    return;
  }

  const downstream = new Server(
    { name: entry.appName, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  downstream.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await upstream.listTools();
    return { tools: result.tools };
  });

  downstream.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await upstream.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    });
    return result as typeof result & Record<string, unknown>;
  });

  downstream.setRequestHandler(PingRequestSchema, async () => ({}));

  const transport = new StdioServerTransport();
  await downstream.connect(transport);
  console.error(`[webdesktopmcp] Ready — ${entry.appName} tools are available to this MCP client.`);

  const shutdown = () => {
    void upstream.close();
    void downstream.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err: unknown) => {
  console.error(`[webdesktopmcp] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
