/** Mirrors successful imperative native registrations into the desktop host. */
import { ModelContext } from "./polyfill.js";
import type { HostBridgeLike, ModelContextRegisterToolOptions, ModelContextTool, PolyfillInstallOptions } from "./types.js";

export interface NativeMirrorHandle {
  dispose(): void;
  listTools(): { name: string; description: string }[];
}

export function installNativeModelContextMirror(
  bridge: HostBridgeLike,
  log: NonNullable<PolyfillInstallOptions["log"]>,
): NativeMirrorHandle | null {
  const native = typeof document !== "undefined"
    ? (document as unknown as { modelContext?: { registerTool?: unknown } }).modelContext
    : undefined;
  if (typeof native?.registerTool !== "function") return null;
  const mc = native as {
    registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<undefined>;
  };
  const originalRegister = mc.registerTool;
  const external = new ModelContext(bridge, "native-mirror", log);
  const lifetimes = new Set<AbortController>();
  let disposed = false;

  mc.registerTool = async (tool, options = {}) => {
    if (disposed) throw new DOMException("Mirror disposed", "InvalidStateError");
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      lifetimes.delete(controller);
    };
    controller.signal.addEventListener("abort", cleanup, { once: true });
    lifetimes.add(controller);
    try {
      // Native and external registration share one lifetime. A rejection on
      // either side rolls back only this registration, never an existing tool.
      await originalRegister.call(native, tool, { ...options, signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException("Registration aborted", "AbortError");
      await external.registerTool(tool, { ...options, signal: controller.signal });
      return undefined;
    } catch (error) {
      controller.abort();
      cleanup();
      throw error;
    }
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      mc.registerTool = originalRegister;
      for (const controller of lifetimes) controller.abort();
      external.dispose();
    },
    listTools() {
      return external.registeredToolNames.map(name => ({
        name,
        description: external.findLocal(name)!.declaration.description,
      }));
    },
  };
}
