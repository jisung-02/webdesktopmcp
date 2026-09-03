/**
 * Electron preload — runs in the isolated world with contextIsolation on.
 *
 * 1. Exposes the host bridge to the main world via contextBridge.
 * 2. Injects the bundled main-world bootstrap (native-mirror / polyfill
 *    selection happens there) via webFrame.executeJavaScript, which runs in
 *    the frame's MAIN world before page scripts — no DOM access needed and
 *    immune to page CSP.
 *
 * Safe to run twice (window-level preload + session-level registration):
 * both steps are idempotent.
 */
import { contextBridge, ipcRenderer, webFrame } from "electron";
// Injected at build time by build.mjs (bundled IIFE of src/main-world.ts).
import mainWorldSource from "./generated/main-world.js.txt";

const SEND_CHANNEL = "webdesktopmcp:message";
const RECV_CHANNEL = "webdesktopmcp:host-message";

declare global {
  // eslint-disable-next-line no-var
  var __webDesktopMcpHost: unknown;
}

if (!(globalThis as { __webDesktopMcpHost?: unknown }).__webDesktopMcpHost) {
  const handlers = new Set<(message: unknown) => void>();
  ipcRenderer.on(RECV_CHANNEL, (_event, message: unknown) => {
    for (const handler of handlers) handler(message);
  });
  try {
    contextBridge.exposeInMainWorld("__webDesktopMcpHost", {
      send: (message: unknown) => {
        ipcRenderer.send(SEND_CHANNEL, message);
      },
      onMessage: (handler: (message: unknown) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    });
  } catch {
    // A duplicate preload run (window-level + session-level) in another
    // isolated world raced us: the main world already has the bridge.
  }

  try {
    void webFrame.executeJavaScript(mainWorldSource as unknown as string);
  } catch (err) {
    console.error("[webdesktopmcp] main-world injection failed:", err);
  }
}
