/**
 * Main-world bootstrap (injected by the preload). Runs before page scripts,
 * selects between the native mirror and the polyfill via
 * `bootstrapWebDesktopMcp` from @webdesktopmcp/core.
 */
import { bootstrapWebDesktopMcp } from "@webdesktopmcp/core";

const w = window as unknown as Record<string, unknown>;
const bridge = w.__webDesktopMcpHost as
  | { send(m: unknown): void; onMessage(h: (m: unknown) => void): () => void }
  | undefined;

// Idempotence: duplicate preload runs must not bootstrap twice.
if (bridge && typeof document !== "undefined" && !w.__webDesktopMcpBootstrapped) {
  w.__webDesktopMcpBootstrapped = true;
  bootstrapWebDesktopMcp({
    bridge,
    frameId: "electron",
    appName: (window as unknown as Record<string, string>).__WEBDESKTOPMCP_APP_NAME ?? "electron-app",
    appVersion: "0",
    native: "auto",
    log: (level, message) => {
      // eslint-disable-next-line no-console
      console[level === "debug" ? "debug" : level](
        `%cwebdesktopmcp%c ${message}`,
        "background:#2563eb;color:#fff;padding:0 4px;border-radius:3px",
        "",
      );
    },
  });
}
