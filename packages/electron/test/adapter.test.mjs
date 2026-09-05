import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as server from "@webdesktopmcp/server";
import * as protocol from "@webdesktopmcp/protocol";

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const channel = "webdesktopmcp:message";

async function fixture(t, options = {}) {
  const ipcMain = new EventEmitter();
  const app = new EventEmitter();
  app.commandLine = { appendSwitch() {} };
  app.getVersion = () => "test";
  const frames = new Map();
  const electron = { app, ipcMain, webContents: { fromId: id => frames.get(id) } };
  const exports = {};
  // Only Electron's native boundary and server startup/storage are mocked.
  // Authorization, routing, and invocation ownership use the actual registry.
  vm.runInNewContext(readFileSync(entry, "utf8"), {
    exports,
    require: name => name === "electron" ? electron : name === "@webdesktopmcp/server" ? {
      ...server,
      startLocalMcpServer: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
      upsertAppEntry: async () => {},
      removeAppEntry: async () => {},
    } : name === "@webdesktopmcp/protocol" ? protocol : require(name),
    __dirname: fileURLToPath(new URL("../dist", import.meta.url)),
    process, console, setTimeout, clearTimeout,
  }, { filename: entry });
  const handle = exports.installWebDesktopMcp({ appName: "adapter-fixture", log() {}, ...options });
  await handle.ready;
  t.after(async () => {
    for (const id of frames.keys()) handle.registry.removeFrame(String(id));
    await handle.dispose();
  });
  const frame = (id, url) => {
    const wc = new EventEmitter();
    Object.assign(wc, {
      id, mainFrame: { url, parent: null }, sent: [],
      session: { registerPreloadScript() {} },
      isDestroyed: () => false, getURL: () => url,
      send(_channel, message) { this.sent.push(message); },
    });
    frames.set(id, wc);
    app.emit("web-contents-created", {}, wc);
    return wc;
  };
  const send = (wc, message, senderFrame = wc.mainFrame) => {
    ipcMain.emit(channel, { sender: wc, senderFrame }, message);
  };
  const register = (wc, name, exposedTo) => send(wc, {
    kind: "register", invocationId: `register-${name}`,
    tool: { name, description: "Test tool" }, exposedTo,
  });
  return { handle, ipcMain, frame, send, register };
}

test("IPC derives origins from the sender frame, ignoring claimed origins", { timeout: 3000 }, async t => {
  const { frame, send, register, handle } = await fixture(t);
  const owner = frame(1, "https://owner.example/page");
  const foreign = frame(2, "https://foreign.example/page");
  register(owner, "private-tool");
  assert.equal(handle.registry.get("private-tool").origin, "https://owner.example");
  send(foreign, { kind: "getToolsRequest", requestId: "list", forOrigin: "https://owner.example" });
  assert.deepEqual(foreign.sent.at(-1).tools, []);
  send(foreign, { kind: "executeForward", requestId: "spoof", name: "private-tool", input: {}, fromOrigin: "https://owner.example" });
  assert.equal(foreign.sent.at(-1).errorCode, "SecurityError");
  send(owner, { kind: "executeForward", requestId: "own", name: "private-tool", input: {}, fromOrigin: "https://foreign.example" });
  const call = owner.sent.at(-1);
  assert.equal(call.kind, "execute");
  send(owner, { kind: "executeResult", invocationId: call.invocationId, ok: true, result: '"owned"' });
  assert.equal(owner.sent.at(-1).result, '"owned"');
});

test("a foreign sender cannot settle an owner's pending external invocation", { timeout: 3000 }, async t => {
  const { frame, send, register, handle } = await fixture(t);
  const owner = frame(1, "https://owner.example");
  const foreign = frame(2, "https://foreign.example");
  register(owner, "echo");
  const pending = handle.registry.invoke("echo", {}, new AbortController().signal);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const call = owner.sent.at(-1);
  send(foreign, { kind: "executeResult", invocationId: call.invocationId, ok: true, result: '"forged"' });
  await Promise.resolve();
  assert.equal(settled, false);
  send(owner, { kind: "executeResult", invocationId: call.invocationId, ok: true, result: '"authentic"' });
  assert.equal(await pending, '"authentic"');
});

test("child iframe messages cannot impersonate their WebContents owner", { timeout: 3000 }, async t => {
  const { frame, send, handle } = await fixture(t);
  const owner = frame(1, "https://owner.example");
  send(owner, { kind: "register", invocationId: "child", tool: { name: "child-tool", description: "Child" } },
    { parent: owner.mainFrame, url: "https://child.example" });
  assert.equal(handle.registry.get("child-tool"), undefined);
});

test("cancelForward aborts the owner's execution and replies to its caller", { timeout: 3000 }, async t => {
  const { frame, send, register } = await fixture(t);
  const owner = frame(1, "https://owner.example");
  const caller = frame(2, "https://caller.example");
  register(owner, "shared", ["https://caller.example"]);
  send(caller, { kind: "executeForward", requestId: "cancel-me", name: "shared", input: {}, fromOrigin: "https://caller.example" });
  const call = owner.sent.at(-1);
  assert.equal(call.kind, "execute");
  send(caller, { kind: "cancelForward", requestId: "cancel-me" });
  assert.equal(owner.sent.at(-1).kind, "abort");
  assert.equal(owner.sent.at(-1).invocationId, call.invocationId);
  assert.equal(caller.sent.at(-1).errorCode, "AbortError");
});

test("native off config forces the polyfill and dispose removes IPC handlers", { timeout: 3000 }, async t => {
  const { ipcMain, frame, handle } = await fixture(t, { native: "off" });
  const owner = frame(1, "https://owner.example");
  const event = { sender: owner, senderFrame: owner.mainFrame };
  ipcMain.emit("webdesktopmcp:config", event);
  assert.equal(event.returnValue?.native, "force-polyfill");
  await handle.dispose();
  assert.equal(ipcMain.listenerCount(channel), 0);
  assert.equal(ipcMain.listenerCount("webdesktopmcp:config"), 0);
});
