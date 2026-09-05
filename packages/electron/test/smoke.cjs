const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { app, BrowserWindow } = require("electron");
const { readAppEntry } = require("@webdesktopmcp/server");
const { installWebDesktopMcp } = require("../dist/index.js");

app.on("window-all-closed", () => {});

const appName = `webdesktopmcp-smoke-${process.pid}`;
const mcp = installWebDesktopMcp({ appName, native: "off", log() {} });
let win;
let generation = 0;
let rpcId = 0;
const pageServer = http.createServer((request, response) => {
  if (request.url !== "/") { response.writeHead(404).end(); return; }
  const current = ++generation;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>WebMCP integration smoke</title>
    <h1>WebMCP integration check</h1><output id="result">Waiting</output>
    <form toolname="smoke-form" tooldescription="Show a greeting" toolautosubmit>
      <input name="name" required><button>Greet</button>
    </form>
    <script>
      window.smokeGeneration = ${current};
      document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        const text = 'Hello ' + document.querySelector('input').value;
        document.querySelector('#result').textContent = text;
        if (event.agentInvoked) event.respondWith({ greeting: text });
      });
      window.smokeReady = (async () => {
        while (!document.modelContext) await new Promise(resolve => setTimeout(resolve, 10));
        await document.modelContext.registerTool({
          name: 'smoke-echo', description: 'Echo into the visible page',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          execute: async ({ text }) => {
            document.querySelector('#result').textContent = text;
            return { text, generation: ${current} };
          }
        });
        window.registration = new AbortController();
        await document.modelContext.registerTool({ name: 'smoke-temporary', description: 'Temporary tool', execute: async () => null }, { signal: registration.signal });
        if (${current} === 1) await document.modelContext.registerTool({ name: 'smoke-old-page', description: 'First document only', execute: async () => null });
        return true;
      })();
    </script>`);
});

async function waitUntil(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  pageServer.listen(0, "127.0.0.1");
  await once(pageServer, "listening");
  await app.whenReady();
  const endpoint = await mcp.ready;
  const rpc = async (method, params = {}) => {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  };
  win = new BrowserWindow({
    width: 480, height: 260, show: true,
    webPreferences: { preload: mcp.preloadPath, contextIsolation: true, nodeIntegration: false },
  });
  const evaluate = script => win.webContents.executeJavaScript(script);
  await win.loadURL(`http://127.0.0.1:${pageServer.address().port}/`);
  assert.equal(await evaluate("window.smokeReady"), true);
  assert.equal(await evaluate("window.__webDesktopMcpHost.native"), "force-polyfill");
  assert.equal(await evaluate("typeof document.modelContext.unregisterTool"), "function");
  await waitUntil(() => mcp.registry.get("smoke-form"), "declarative form registration");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "electron-smoke", version: "1" } });
  const names = (await rpc("tools/list")).tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), ["smoke-echo", "smoke-form", "smoke-old-page", "smoke-temporary"]);
  const echo = await rpc("tools/call", { name: "smoke-echo", arguments: { text: "HTTP echo" } });
  assert.deepEqual(JSON.parse(echo.content[0].text), { text: "HTTP echo", generation: 1 });
  assert.equal(await evaluate("document.querySelector('#result').textContent"), "HTTP echo");
  const form = await rpc("tools/call", { name: "smoke-form", arguments: { name: "Desktop" } });
  assert.deepEqual(JSON.parse(form.content[0].text), { greeting: "Hello Desktop" });
  assert.equal(await evaluate("document.querySelector('#result').textContent"), "Hello Desktop");
  const pageResult = await evaluate(`(async () => {
    const tools = await document.modelContext.getTools();
    return document.modelContext.executeTool(tools.find(tool => tool.name === 'smoke-echo'), { text: 'Page call' });
  })()`);
  assert.deepEqual(JSON.parse(pageResult), { text: "Page call", generation: 1 });
  await evaluate("registration.abort()");
  await waitUntil(() => !mcp.registry.get("smoke-temporary"), "registration abort removal");
  assert(!(await rpc("tools/list")).tools.some(tool => tool.name === "smoke-temporary"));
  const loaded = once(win.webContents, "did-finish-load");
  win.reload();
  await loaded;
  assert.equal(await evaluate("window.smokeReady"), true);
  await waitUntil(() => !mcp.registry.get("smoke-old-page") && mcp.registry.get("smoke-temporary"), "navigation cleanup and registration");
  const reloaded = await rpc("tools/call", { name: "smoke-echo", arguments: { text: "Reloaded" } });
  assert.deepEqual(JSON.parse(reloaded.content[0].text), { text: "Reloaded", generation: 2 });
  console.log(`PASS Electron ${process.versions.electron} / Chromium ${process.versions.chrome}: visible BrowserWindow, preload forced polyfill, HTTP imperative/form calls and UI results, page execution, registration abort, reload cleanup.`);
}

const watchdog = setTimeout(() => { console.error("Electron smoke exceeded 30 seconds"); void finish(1); }, 30000);
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  win?.destroy();
  await mcp.dispose();
  assert.equal(await readAppEntry(appName), undefined, "Smoke app registration must be removed");
  console.log(`Cleanup verified: ${appName}`);
  await new Promise(resolve => pageServer.close(resolve));
  app.exit(code);
}
run().then(() => finish(0), error => { console.error(error); return finish(1); });
