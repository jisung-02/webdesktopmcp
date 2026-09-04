/**
 * Unified renderer bootstrap: decides between the native mirror (runtime
 * ships WebMCP natively) and the polyfill (everything else). Adapters
 * (Electron/Tauri/Wails) inject this single entry point.
 */

import { PROTOCOL_VERSION } from "@webdesktopmcp/protocol";
import type { HostBridgeLike, InstalledPolyfill, PolyfillInstallOptions } from "./types.js";
import { installModelContextPolyfill } from "./polyfill.js";
import { installNativeModelContextMirror, type NativeMirrorHandle } from "./native-mirror.js";

export type NativePreference = "auto" | "force-polyfill" | "require-native";

export interface BootstrapOptions extends PolyfillInstallOptions {
  /**
   * `auto` (default): native `document.modelContext` → mirror registrations
   * to the host; otherwise install the polyfill.
   * `force-polyfill`: always polyfill (spec-identical semantics today, e.g.
   * for tests or when the native build is behind an unsettled draft).
   * `require-native`: only mirror; fail loudly when native support is absent.
   */
  native?: NativePreference;
}

export interface BootstrapHandle {
  mode: "native-mirror" | "polyfill";
  dispose(): void;
  registeredToolNames: readonly string[];
}

export function bootstrapWebDesktopMcp(options: BootstrapOptions): BootstrapHandle | null {
  const preference = options.native ?? "auto";
  const hasNative =
    typeof document !== "undefined" && "modelContext" in document;

  if (hasNative && preference !== "force-polyfill") {
    const mirror = installNativeModelContextMirror(options.bridge, options.log ?? (() => {}));
    if (mirror) {
      // Console debug helper, same shape as the polyfill installs.
      (globalThis as unknown as Record<string, unknown>).__webDesktopMcp = {
        version: PROTOCOL_VERSION,
        mode: "native-mirror",
        listTools: () => mirror.listTools(),
      };
      return wrapMirror(mirror);
    }
    if (preference === "require-native") {
      options.log?.("error", "[webdesktopmcp] require-native set but mirroring failed.");
      return null;
    }
  }

  if (preference === "require-native") {
    options.log?.(
      "error",
      "[webdesktopmcp] Native WebMCP not present in this runtime. Enable it via the runtime switch (see docs) or set native: 'auto'.",
    );
    return null;
  }

  const polyfill = installModelContextPolyfill(options);
  return polyfill ? wrapPolyfill(polyfill) : null;
}

function wrapMirror(mirror: NativeMirrorHandle): BootstrapHandle {
  return {
    mode: "native-mirror",
    dispose: () => mirror.dispose(),
    registeredToolNames: [],
  };
}

function wrapPolyfill(polyfill: InstalledPolyfill): BootstrapHandle {
  return {
    mode: "polyfill",
    dispose: () => polyfill.dispose(),
    get registeredToolNames() {
      return polyfill.registeredToolNames;
    },
  };
}

/** Type re-export for adapters. */
export type { HostBridgeLike };
