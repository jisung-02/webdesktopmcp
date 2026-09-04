/**
 * Native mirror mode — for runtimes whose Chromium already ships WebMCP
 * (Electron rebased onto Chromium ≥ 149, WebView2 on Edge ≥ 150 runtimes).
 *
 * The page keeps using the 100%-native `document.modelContext`. We wrap
 * `registerTool` transparently so every registration is *mirrored* to the
 * desktop host (→ local MCP server → external agents like Claude/Cursor),
 * while built-in browser agents keep seeing the tools through the native
 * path. External invocations are routed into the execute callback we captured
 * at registration — behaviour is identical because it IS the native tool.
 */

import type { RegisteredToolInfo } from "@webdesktopmcp/protocol";
import type { HostBridgeLike, PolyfillInstallOptions } from "./types.js";

interface MirroredTool {
  name: string;
  description: string;
  execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
}

export interface NativeMirrorHandle {
  dispose(): void;
  /** Debug helper: mirrored registrations seen so far. */
  listTools(): { name: string; description: string }[];
}

export function installNativeModelContextMirror(
  bridge: HostBridgeLike,
  log: NonNullable<PolyfillInstallOptions["log"]>,
): NativeMirrorHandle | null {
  const doc = typeof document !== "undefined" ? document : undefined;
  const native = (doc as unknown as { modelContext?: { registerTool?: unknown } } | undefined)
    ?.modelContext;
  if (typeof native?.registerTool !== "function") {
    log("warn", "[webdesktopmcp] Native mirror requested but no native modelContext found.");
    return null;
  }

  const mc = native as {
    registerTool: (tool: unknown, options?: unknown) => Promise<undefined>;
  };
  const originalRegister = mc.registerTool;
  const callOriginal = originalRegister.bind(native);
  const mirrored = new Map<string, MirroredTool>();
  const invocations = new Map<string, AbortController>();

  mc.registerTool = (tool: unknown, options?: unknown): Promise<undefined> => {
    const t = tool as MirroredTool & { description: string };
    if (!isObjectTool(t)) {
      return callOriginal(tool, options);
    }
    mirrored.set(t.name, { name: t.name, description: t.description, execute: t.execute });
    bridge.send({
      kind: "register",
      invocationId: `mirror-${t.name}-${Date.now()}`,
      tool: {
        name: t.name,
        description: t.description,
        inputSchema: (t as { inputSchema?: unknown }).inputSchema,
        annotations: (t as { annotations?: unknown }).annotations,
      },
    });
    return callOriginal(tool, options);
  };
  // Keep the wrapper invisible to feature checks that look at arity/name.
  Object.defineProperty(mc.registerTool, "name", { value: "registerTool", configurable: true });

  const unsub = bridge.onMessage((raw) => {
    const msg = raw as Record<string, unknown>;
    if (msg.kind === "execute") {
      const name = msg.name as string;
      const target = mirrored.get(name);
      if (!target) return; // Not ours — polyfill handles its own tools.
      const controller = new AbortController();
      const invocationId = msg.invocationId as string;
      invocations.set(invocationId, controller);
      Promise.resolve()
        .then(() =>
          target.execute(
            isPlainObject(msg.input) ? msg.input : {},
            { signal: controller.signal },
          ),
        )
        .then((result) => {
          let serialised: string;
          try {
            serialised = JSON.stringify(result ?? null);
          } catch {
            throw new Error("Tool result is not JSON-serialisable.");
          }
          bridge.send({ kind: "executeResult", invocationId, ok: true, result: serialised });
        })
        .catch((err: unknown) => {
          bridge.send({
            kind: "executeResult",
            invocationId,
            ok: false,
            errorCode:
              (err as { name?: string } | null)?.name === "AbortError" ? "AbortError" : "ExecutionError",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => invocations.delete(invocationId));
    } else if (msg.kind === "abort") {
      invocations.get(msg.invocationId as string)?.abort();
    } else if (msg.kind === "toolsChanged") {
      // Host-side view changed (e.g. a frame disappeared): nothing to do for
      // the page — native cross-document behaviour remains native.
      void 0;
    }
  });

  log("info", "[webdesktopmcp] Native WebMCP detected — mirroring registrations to host bridge.");

  return {
    dispose() {
      unsub();
      mc.registerTool = originalRegister;
      for (const name of mirrored.keys()) {
        bridge.send({ kind: "unregister", invocationId: `mirror-dispose-${name}`, name });
      }
      mirrored.clear();
      for (const c of invocations.values()) c.abort();
      invocations.clear();
    },
    listTools() {
      return [...mirrored.values()].map(({ name, description }) => ({ name, description }));
    },
  };
}

function isObjectTool(v: unknown): v is { name: string; description: string } {
  return typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unused today; kept for the typed export surface. */
export type { RegisteredToolInfo };
