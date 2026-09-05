/**
 * Electron adapter — the main-process half of webdesktopmcp.
 *
 * Usage:
 *   import { installWebDesktopMcp } from "@webdesktopmcp/electron";
 *   const mcp = installWebDesktopMcp({ appName: "MyApp", appVersion: "1.0.0" });
 *   // then either add `preload: mcp.preloadPath` to your BrowserWindow
 *   // webPreferences, or rely on automatic session-level registration.
 *
 * Native WebMCP: call before `app.whenReady()`. When the bundled Chromium is
 * new enough (>= 149, where WebMCP ships behind a flag), the adapter enables
 * it via --enable-blink-features and the injected bootstrap switches to the
 * native mirror automatically (the page uses the real document.modelContext;
 * registrations are mirrored out to the local MCP server).
 */

import { app, ipcMain, webContents, type Session } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ToolRegistry,
  startLocalMcpServer,
  upsertAppEntry,
  removeAppEntry,
  type HostAdapter,
  type RunningLocalServer,
} from "@webdesktopmcp/server";
import {
  HOST_BRIDGE_GLOBAL,
  normalizeOrigin,
  type RegisteredToolInfo,
  type RendererMessage,
} from "@webdesktopmcp/protocol";

const SEND_CHANNEL = "webdesktopmcp:message";
const RECV_CHANNEL = "webdesktopmcp:host-message";
const CONFIG_CHANNEL = "webdesktopmcp:config";

/** Chromium version whose WebMCP origin trial/flag the mirror targets. */
export const NATIVE_MIN_CHROMIUM = 149;

export function chromiumSupportsNativeWebMcp(
  chromeVersion: string = process.versions.chrome ?? "0",
): boolean {
  const major = Number.parseInt(chromeVersion.split(".")[0] ?? "0", 10);
  return Number.isFinite(major) && major >= NATIVE_MIN_CHROMIUM;
}

export interface WebDesktopMcpOptions {
  appName: string;
  appVersion?: string;
  /**
   * `auto` (default): when the bundled Chromium supports WebMCP natively,
   * enable it via --enable-blink-features and mirror native registrations.
   * `off`: always use the polyfill.
   */
  native?: "auto" | "off";
  /** Blink runtime feature name, in case upstream renames it. */
  blinkFeatureName?: string;
  /** Fixed port for the local MCP endpoint. Default: ephemeral. */
  port?: number;
  /**
   * Gate before external agent tool calls execute (e.g. show a native
   * dialog for sensitive tools). Return false to refuse.
   */
  confirmToolCall?: (tool: RegisteredToolInfo, input: unknown) => boolean | Promise<boolean>;
  log?: (message: string) => void;
}

export interface WebDesktopMcpHandle {
  /** Add to BrowserWindow `webPreferences.preload` (belt & braces — the
   * session-level registration usually makes this unnecessary). */
  preloadPath: string;
  /** Resolves with the loopback MCP endpoint once it is up. */
  ready: Promise<RunningLocalServer>;
  registry: ToolRegistry;
  dispose(): Promise<void>;
}

export function installWebDesktopMcp(options: WebDesktopMcpOptions): WebDesktopMcpHandle {
  if (!app) {
    throw new Error("installWebDesktopMcp must be called in the Electron main process.");
  }
  const log = options.log ?? ((message: string) => console.log(`[webdesktopmcp] ${message}`));

  // Version gate — must run before app ready to affect the render process.
  const nativePreference = options.native ?? "auto";
  if (nativePreference === "auto" && chromiumSupportsNativeWebMcp()) {
    app.commandLine.appendSwitch(
      "enable-blink-features",
      options.blinkFeatureName ?? "WebMCP",
    );
    log(
      `Chromium ${process.versions.chrome} is eligible for WebMCP — requested Blink feature; renderer feature detection selects the mode.`,
    );
  } else {
    log(
      `Chromium ${process.versions.chrome} uses renderer feature detection (native preference: ${nativePreference}).`,
    );
  }

  // ---- Registry + frame adapter -------------------------------------------
  const frameGoneCallbacks = new Set<(frameId: string) => void>();
  const adapter: HostAdapter = {
    sendToFrame(frameId, message) {
      const wc = webContents.fromId(Number(frameId));
      if (wc && !wc.isDestroyed()) wc.send(RECV_CHANNEL, message);
    },
    onFrameGone(cb) {
      frameGoneCallbacks.add(cb);
    },
  };
  const registry = new ToolRegistry(adapter, { invocationTimeoutMs: 120_000 });

  const onConfig = (event: Electron.IpcMainEvent) => {
    event.returnValue = { native: nativePreference === "off" ? "force-polyfill" : "auto" };
  };
  ipcMain.on(CONFIG_CHANNEL, onConfig);
  const onMessage = (event: Electron.IpcMainEvent, raw: RendererMessage) => {
    // This adapter identifies WebContents, not DOM subframes. Only its main
    // document can own tools or send replies through the bridge.
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
    if (!raw || typeof raw !== "object") return;
    const frameId = String(event.sender.id);
    const origin = normalizeOrigin(event.senderFrame.url || event.sender.getURL());
    switch (raw.kind) {
      case "register": {
        registry.handleRegister(frameId, raw.invocationId, raw.tool, raw.exposedTo, origin);
        break;
      }
      case "unregister":
        registry.handleUnregister(frameId, raw.name);
        break;
      case "executeResult":
        registry.handleExecuteResult(frameId, raw.invocationId, raw.ok, raw.result, raw.errorCode, raw.errorMessage);
        break;
      case "executeForward":
        registry.handleExecuteForward(frameId, raw.requestId, raw.name, raw.input, origin);
        break;
      case "cancelForward":
        registry.handleCancelForward(frameId, raw.requestId);
        break;
      case "getToolsRequest":
        registry.handleGetToolsRequest(frameId, raw.requestId, origin, raw.fromOrigins);
        break;
      case "log":
        if (raw.level === "error") console.error(`[webdesktopmcp:frame] ${raw.message}`);
        else if (raw.level === "warn") console.warn(`[webdesktopmcp:frame] ${raw.message}`);
        else console.log(`[webdesktopmcp:frame] ${raw.message}`);
        break;
      default:
        break;
    }
  };
  ipcMain.on(SEND_CHANNEL, onMessage);

  // ---- Preload wiring ------------------------------------------------------
  const preloadPath = path.join(__dirname, "preload.cjs");
  const preloadedSessions = new WeakSet<Session>();
  const trackedContents = new Map<string, Electron.WebContents>();

  const ensureSessionPreload = (session: Session): void => {
    if (preloadedSessions.has(session)) return;
    preloadedSessions.add(session);
    const s = session as Session & {
      registerPreloadScript?: (def: { id?: string; type: string; filePath: string }) => void;
      setPreloads?: (paths: string[]) => void;
      getPreloads?: () => string[];
    };
    try {
      if (typeof s.registerPreloadScript === "function") {
        // Electron >= 35 API.
        s.registerPreloadScript({ id: "webdesktopmcp", type: "frame", filePath: preloadPath });
        return;
      }
      if (typeof s.setPreloads === "function" && typeof s.getPreloads === "function") {
        s.setPreloads([...s.getPreloads(), preloadPath]);
        return;
      }
    } catch (err) {
      log(`Session preload registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(
      "Could not register the preload automatically — add `preload: mcp.preloadPath` to your BrowserWindow webPreferences.",
    );
  };

  const onWebContentsCreated = (_event: unknown, wc: Electron.WebContents): void => {
    ensureSessionPreload(wc.session);
    trackedContents.set(String(wc.id), wc);
    // A committed navigation replaces the document, and W3C tools are
    // per-document: drop the old document's tools. In-page (pushState)
    // navigations fire `did-navigate-in-page` instead, so SPA routes keep
    // their tools. Reloads re-register afterwards (same-frame register
    // replaces in the registry), so this is safe across the dev loop.
    wc.on("did-navigate", () => {
      for (const cb of frameGoneCallbacks) cb(String(wc.id));
    });
    wc.once("destroyed", () => {
      trackedContents.delete(String(wc.id));
      for (const cb of frameGoneCallbacks) cb(String(wc.id));
    });
  };
  app.on("web-contents-created", onWebContentsCreated);
  const stopChanges = registry.onToolsChanged(() => {
    for (const [frameId, wc] of trackedContents) {
      if (wc.isDestroyed()) continue;
      const origin = normalizeOrigin(wc.getURL());
      adapter.sendToFrame(frameId, {
        kind: "toolsChanged",
        tools: registry.list().filter(t => t.frameId === frameId ||
          (origin !== "null" && !!origin && (t.origin === origin || t.exposedTo?.includes(origin)))),
      });
    }
  });

  // ---- Local MCP server ----------------------------------------------------
  const token = randomBytes(24).toString("base64url");
  const ready = startLocalMcpServer({
    appName: options.appName,
    appVersion: options.appVersion ?? app.getVersion?.() ?? "0.0.0",
    registry,
    port: options.port,
    token,
    confirmToolCall: options.confirmToolCall,
    log: (level, message) => log(`${level}: ${message}`),
  }).then((server) => {
    readyRef = server;
    return upsertAppEntry({
      appName: options.appName,
      url: server.url,
      token,
      pid: process.pid,
    }).then(() => {
      log(
        `MCP endpoint ready at ${server.url} — connect with: npx @webdesktopmcp/cli connect --app "${options.appName}"`,
      );
      return server;
    });
  });
  // Surface startup failures even when the app never awaits `ready`.
  ready.catch((err: unknown) => {
    log(
      `MCP server failed to start: ${err instanceof Error ? err.message : String(err)} — agents cannot connect until this is fixed (port conflict?).`,
    );
  });

  const handle: WebDesktopMcpHandle = {
    preloadPath,
    ready,
    registry,
    async dispose() {
      app.off("web-contents-created", onWebContentsCreated);
      ipcMain.off(SEND_CHANNEL, onMessage);
      ipcMain.off(CONFIG_CHANNEL, onConfig);
      stopChanges();
      for (const frameId of trackedContents.keys()) registry.removeFrame(frameId);
      trackedContents.clear();
      await ready.catch(() => {});
      await removeAppEntry(options.appName).catch(() => {});
      await readyRef?.close().catch(() => {});
    },
  };
  let readyRef: RunningLocalServer | undefined;

  return handle;
}

export { HOST_BRIDGE_GLOBAL };
