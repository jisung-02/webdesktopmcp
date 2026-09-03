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
      `Chromium ${process.versions.chrome} supports WebMCP — enabled natively via --enable-blink-features.`,
    );
  } else {
    log(
      `Chromium ${process.versions.chrome} has no native WebMCP (needs >= ${NATIVE_MIN_CHROMIUM}) — using the polyfill.`,
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

  ipcMain.on(SEND_CHANNEL, (event, raw: RendererMessage) => {
    const frameId = String(event.sender.id);
    const origin = normalizeOrigin(event.senderFrame?.origin || event.sender.getURL());
    switch (raw.kind) {
      case "register": {
        const outcome = registry.handleRegister(frameId, raw.invocationId, raw.tool, raw.exposedTo);
        if (outcome.ok) registry.setOrigin(raw.tool.name, origin);
        break;
      }
      case "unregister":
        registry.handleUnregister(frameId, raw.name);
        break;
      case "executeResult":
        registry.handleExecuteResult(raw.invocationId, raw.ok, raw.result, raw.errorCode, raw.errorMessage);
        break;
      case "executeForward":
        registry.handleExecuteForward(frameId, raw.requestId, raw.name, raw.input, raw.fromOrigin);
        break;
      case "getToolsRequest":
        registry.handleGetToolsRequest(frameId, raw.requestId, raw.forOrigin, raw.fromOrigins);
        break;
      case "log":
        if (raw.level === "error") console.error(`[webdesktopmcp:frame] ${raw.message}`);
        else if (raw.level === "warn") console.warn(`[webdesktopmcp:frame] ${raw.message}`);
        else console.log(`[webdesktopmcp:frame] ${raw.message}`);
        break;
      default:
        break;
    }
  });

  // ---- Preload wiring ------------------------------------------------------
  const preloadPath = path.join(__dirname, "preload.cjs");
  const preloadedSessions = new WeakSet<Session>();

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
    wc.once("destroyed", () => {
      for (const cb of frameGoneCallbacks) cb(String(wc.id));
    });
  };
  app.on("web-contents-created", onWebContentsCreated);

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

  const handle: WebDesktopMcpHandle = {
    preloadPath,
    ready,
    registry,
    async dispose() {
      app.off("web-contents-created", onWebContentsCreated);
      await removeAppEntry(options.appName).catch(() => {});
      await readyRef?.close().catch(() => {});
    },
  };
  let readyRef: RunningLocalServer | undefined;

  return handle;
}

export { HOST_BRIDGE_GLOBAL };
