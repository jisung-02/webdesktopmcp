import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLocalMcpServer, ToolRegistry, type HostAdapter } from "../src/index.js";
import type { HostMessage, RendererMessage } from "@webdesktopmcp/protocol";

/** Captures messages per frame; tests reply to executions like a webview would. */
class MockAdapter implements HostAdapter {
  frames = new Map<string, RendererMessage[]>();
  #frameGoneCallbacks = new Set<(frameId: string) => void>();

  sendToFrame(frameId: string, message: unknown): void {
    const list = this.frames.get(frameId) ?? [];
    list.push(message as RendererMessage);
    this.frames.set(frameId, list);
  }

  onFrameGone(cb: (frameId: string) => void): void {
    this.#frameGoneCallbacks.add(cb);
  }

  simulateFrameGone(frameId: string): void {
    for (const cb of this.#frameGoneCallbacks) cb(frameId);
  }

  /** Reply to the latest `execute` sent to a frame, like the polyfill does. */
  replyExecute(frameId: string, result: unknown): void {
    const messages = this.frames.get(frameId) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.kind === "execute") {
        registry.handleExecuteResult(
          (messages[i] as { invocationId: string }).invocationId,
          true,
          JSON.stringify(result),
        );
        return;
      }
    }
    throw new Error(`No execute message pending for frame ${frameId}`);
  }
}

let adapter: MockAdapter;
let registry: ToolRegistry;
let closeServer: (() => Promise<void>) | undefined;

beforeEach(() => {
  adapter = new MockAdapter();
  registry = new ToolRegistry(adapter, { invocationTimeoutMs: 2000 });
});

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

const TEST_TOOL = {
  name: "search-cars",
  description: "Perform a car make/model search",
  inputSchema: {
    type: "object",
    properties: {
      make: { type: "string", description: "The vehicle's make" },
      model: { type: "string", description: "The vehicle's model" },
    },
    required: ["make"],
  },
};

async function rpc(url: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  },
};

describe("ToolRegistry", () => {
  it("rejects duplicate names across frames with a descriptive error", () => {
    const r1 = registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    const r2 = registry.handleRegister("frame-2", "reg-2", TEST_TOOL);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.errorMessage).toMatch(/already used by another webview/);
  });

  it("same-frame re-register replaces the entry (reload/dev-loop semantics)", () => {
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    const updated = { ...TEST_TOOL, description: "Updated description" };
    const r2 = registry.handleRegister("frame-1", "reg-2", updated);
    expect(r2.ok).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("search-cars")?.description).toBe("Updated description");
  });

  it("drops a frame's tools when the frame is gone", () => {
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    adapter.simulateFrameGone("frame-1");
    expect(registry.list()).toHaveLength(0);
  });

  it("round-trips an invocation to the owning frame", async () => {
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    const p = registry.invoke("search-cars", { make: "BMW" }, new AbortController().signal);
    adapter.replyExecute("frame-1", { cars: 3 });
    await expect(p).resolves.toBe('{"cars":3}');
  });

  it("times out when the frame never responds", async () => {
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    await expect(
      registry.invoke("search-cars", {}, new AbortController().signal),
    ).rejects.toThrow(/timed out/);
  });

  it("routes executeForward to the owner and returns executeForwardResult to the caller", async () => {
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    registry.handleExecuteForward("frame-2", "req-7", "search-cars", { make: "BMW" }, "https://caller.example");

    const forwarded = adapter.frames.get("frame-1")?.find((m) => m.kind === "execute") as
      | { invocationId: string; name: string }
      | undefined;
    expect(forwarded).toBeDefined();
    registry.handleExecuteResult(forwarded!.invocationId, true, '{"ok":1}');

    const reply = adapter.frames.get("frame-2")?.find((m) => m.kind === "executeForwardResult") as
      | { requestId: string; ok: boolean; result?: string }
      | undefined;
    expect(reply).toMatchObject({ requestId: "req-7", ok: true, result: '{"ok":1}' });
  });

  it("refuses executeForward for exposedTo tools from other origins", async () => {
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL, ["https://trusted.example"]);
    registry.handleExecuteForward("frame-2", "req-8", "search-cars", {}, "https://stranger.example");

    const reply = adapter.frames.get("frame-2")?.find((m) => m.kind === "executeForwardResult") as
      | { requestId: string; ok: boolean; errorCode?: string }
      | undefined;
    expect(reply).toMatchObject({ requestId: "req-8", ok: false, errorCode: "SecurityError" });
    expect(adapter.frames.get("frame-1")?.some((m) => m.kind === "execute") ?? false).toBe(false);
  });
});

describe("local MCP server (HTTP)", () => {
  it("serves a health probe without auth", async () => {
    const server = await startLocalMcpServer({
      appName: "Demo",
      appVersion: "1.0.0",
      registry,
    });
    closeServer = server.close;
    const res = await fetch(`${server.url}?health=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ app: "Demo" });
  });

  it("rejects unauthenticated POSTs", async () => {
    const server = await startLocalMcpServer({ appName: "Demo", appVersion: "1", registry });
    closeServer = server.close;
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
  });

  it("lists and executes webview tools end-to-end", async () => {
    const server = await startLocalMcpServer({ appName: "Demo", appVersion: "1", registry });
    closeServer = server.close;
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);

    const init = await rpc(server.url, server.token, INIT);
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo).toMatchObject({ name: "Demo" });

    // initialized notification (id-less)
    await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const list = await rpc(server.url, server.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    const tools = list.json.result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "search-cars", description: TEST_TOOL.description });
    expect(tools[0].inputSchema.required).toEqual(["make"]);

    // Fire the call without awaiting: the HTTP response only arrives after
    // the mock frame answers the execute request.
    const callPromise = rpc(server.url, server.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search-cars", arguments: { make: "BMW", model: "330i" } },
    });
    await vi.waitUntil(() => adapter.frames.get("frame-1")?.some((m) => m.kind === "execute"));
    adapter.replyExecute("frame-1", { results: ["330i"] });
    const call = await callPromise;
    const result = await call.json;
    expect(result.result.content[0].text).toBe('{"results":["330i"]}');
    expect(result.result.structuredContent).toEqual({ results: ["330i"] });
  });

  it("hides tools that declare exposedTo from external clients", async () => {
    const server = await startLocalMcpServer({ appName: "Demo", appVersion: "1", registry });
    closeServer = server.close;
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL, ["app://internal-agent"]);
    await rpc(server.url, server.token, INIT);
    const list = await rpc(server.url, server.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools).toHaveLength(0);
  });

  it("refuses tools/call for exposedTo tools even when invoked by name", async () => {
    const server = await startLocalMcpServer({ appName: "Demo", appVersion: "1", registry });
    closeServer = server.close;
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL, ["app://internal-agent"]);
    await rpc(server.url, server.token, INIT);
    const call = await rpc(server.url, server.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search-cars", arguments: { make: "BMW" } },
    });
    const result = await call.json;
    // Must be refused at the gate — never routed to the webview.
    expect(adapter.frames.get("frame-1")?.some((m) => m.kind === "execute") ?? false).toBe(false);
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/reserved for in-page agents/);
  });

  it("supports the confirmToolCall gate", async () => {
    let asked = 0;
    const server = await startLocalMcpServer({
      appName: "Demo",
      appVersion: "1",
      registry,
      confirmToolCall: () => {
        asked++;
        return false;
      },
    });
    closeServer = server.close;
    registry.handleRegister("frame-1", "reg-1", TEST_TOOL);
    await rpc(server.url, server.token, INIT);
    const call = await rpc(server.url, server.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search-cars", arguments: { make: "BMW" } },
    });
    const result = await call.json;
    expect(asked).toBe(1);
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/declined/);
  });
});

import { vi } from "vitest";
