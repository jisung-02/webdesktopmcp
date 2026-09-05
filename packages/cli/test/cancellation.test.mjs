import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the published executable and both real SDK transports. The HTTP
// endpoint keeps a tools/call SSE response pending until cancellation arrives.
test("stdio cancellation disconnects only its upstream HTTP call", { timeout: 10_000 }, async (t) => {
  let resolveCall;
  let resolveDisconnect;
  let resolveSurviving;
  const disconnected = new Promise((resolve) => { resolveDisconnect = resolve; });
  const survivingReceived = new Promise((resolve) => { resolveSurviving = resolve; });
  const callReceived = new Promise((resolve) => { resolveCall = resolve; });
  const upstream = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } },
      }));
    } else if (message.method === "tools/call") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      if (message.params.name === "slow") {
        response.on("close", resolveDisconnect);
        resolveCall(message);
      } else if (message.params.name === "surviving") {
        resolveSurviving({ message, response });
      } else {
        response.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "next call" }] },
        })}\n\n`);
      }
    } else {
      response.writeHead(202).end();
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const registry = await mkdtemp(join(tmpdir(), "webdesktopmcp-cli-"));
  t.after(() => rm(registry, { recursive: true, force: true }));
  await writeFile(join(registry, "registry.json"), JSON.stringify({ apps: { Test: {
    appName: "Test", pid: process.pid, token: "test-token", protocolVersion: 1,
    updatedAt: new Date().toISOString(), url: `http://127.0.0.1:${upstream.address().port}/mcp`,
  } } }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "connect", "--app", "Test", "--registry", registry],
    stderr: "pipe",
  });
  const client = new Client({ name: "test-downstream", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const controller = new AbortController();
  const result = client.callTool({ name: "slow", arguments: { value: 42 } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(result);
  const call = await callReceived;
  assert.deepEqual(call.params, { name: "slow", arguments: { value: 42 } });
  const survivingResult = client.callTool({ name: "surviving" });
  void survivingResult.catch(() => {});
  const surviving = await survivingReceived;
  controller.abort(new Error("cancel test"));
  await rejected;
  let timer;
  await Promise.race([
    disconnected,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CLI did not disconnect the cancelled HTTP call")), 1500); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(surviving.response.destroyed, false, "another invocation must remain connected");
  surviving.response.end(`event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0", id: surviving.message.id, result: { content: [{ type: "text", text: "completed" }] },
  })}\n\n`);
  assert.deepEqual((await survivingResult).content, [{ type: "text", text: "completed" }]);
  assert.deepEqual((await client.callTool({ name: "after" })).content, [{ type: "text", text: "next call" }]);
});
