/**
 * ModelContext polyfill — implements the W3C WebMCP draft API
 * (`document.modelContext`) on top of a host bridge, so the same page code
 * works in Electron/Tauri/Wails today and in browsers that ship the native
 * API tomorrow.
 */

import {
  PROTOCOL_VERSION,
  validateToolDeclaration,
  type RegisteredToolInfo,
} from "@webdesktopmcp/protocol";
import { setupDeclarativeApi } from "./declarative.js";
import type {
  HostBridgeLike,
  InstalledPolyfill,
  ModelContextExecuteToolOptions,
  ModelContextGetToolOptions,
  ModelContextRegisterToolOptions,
  ModelContextTool,
  PolyfillInstallOptions,
  RegisteredToolInfo as PublicRegisteredTool,
} from "./types.js";

interface PendingEntry<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  cleanup?: () => void;
}

function domError(name: string, message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, name);
  const e = new Error(message) as Error & { name: string };
  e.name = name;
  return e;
}

function abortError(): Error {
  return domError("AbortError", "The operation was aborted.");
}

function randomId(prefix: string): string {
  const g = globalThis.crypto as Crypto | undefined;
  if (g?.randomUUID) return `${prefix}-${g.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Declared + internal bookkeeping for a tool registered from this document. */
interface LocalTool {
  declaration: ModelContextTool;
  registrationId: string;
  exposedTo?: string[];
  declarative?: boolean;
  cleanup?: () => void;
}

export class ModelContext extends EventTarget {
  readonly #bridge: HostBridgeLike;
  readonly #frameId: string;
  readonly #log: NonNullable<PolyfillInstallOptions["log"]>;
  readonly #localTools = new Map<string, LocalTool>();
  /** Snapshot of tools registered by other frames, as last reported by the host. */
  #remoteTools: RegisteredToolInfo[] = [];
  readonly #registerPending = new Map<string, PendingEntry<undefined> & { toolName: string }>();
  readonly #getToolsPending = new Map<string, PendingEntry<PublicRegisteredTool[]>>();
  readonly #executeForwardPending = new Map<string, PendingEntry<string>>();
  readonly #invocations = new Map<string, AbortController>();
  readonly #unsub: () => void;
  #disposed = false;

  constructor(bridge: HostBridgeLike, frameId: string, log: NonNullable<PolyfillInstallOptions["log"]>) {
    super();
    this.#bridge = bridge;
    this.#frameId = frameId;
    this.#log = log ?? (() => {});
    this.#unsub = bridge.onMessage((raw) => this.#onHostMessage(raw as Record<string, unknown>));
  }

  // -- W3C surface ----------------------------------------------------------

  async registerTool(
    tool: ModelContextTool,
    options: ModelContextRegisterToolOptions = {},
  ): Promise<undefined> {
    this.#assertAlive();
    validateToolDeclaration(tool);
    if (typeof tool.execute !== "function") {
      throw domError("InvalidStateError", `Tool "${tool.name}": execute must be a function.`);
    }
    if (this.#localTools.has(tool.name)) {
      throw domError(
        "InvalidStateError",
        `A tool named "${tool.name}" is already registered in this document.`,
      );
    }
    if (options.signal?.aborted) throw abortError();
    const exposedTo = options.exposedTo?.map((o) => String(o));
    const invocationId = randomId("reg");
    const entry: LocalTool = {
      registrationId: invocationId,
      declaration: tool,
      exposedTo: exposedTo && exposedTo.length > 0 ? exposedTo : undefined,
    };
    const promise = new Promise<undefined>((resolve, reject) => {
      this.#registerPending.set(invocationId, { toolName: tool.name, resolve, reject });
    });
    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => {
        const pending = this.#registerPending.get(invocationId);
        this.#registerPending.delete(invocationId);
        pending?.reject(abortError());
        if (this.#localTools.get(tool.name) === entry) {
          this.#forgetLocal(tool.name);
          this.#bridge.send({ kind: "unregister", invocationId: randomId("unreg"), name: tool.name });
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener("abort", onAbort);
    }

    this.#localTools.set(tool.name, entry);
    this.#bridge.send({
      kind: "register",
      invocationId,
      tool: {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      exposedTo: entry.exposedTo,
    });
    return promise;
  }

  async getTools(options: ModelContextGetToolOptions = {}): Promise<PublicRegisteredTool[]> {
    this.#assertAlive();
    if (options.signal?.aborted) throw abortError();
    const requestId = randomId("gt");
    const promise = new Promise<PublicRegisteredTool[]>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      if (options.signal) {
        if (options.signal.aborted) {
          reject(abortError());
          return;
        }
        onAbort = () => {
          this.#getToolsPending.delete(requestId);
          reject(abortError());
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#getToolsPending.set(requestId, {
        resolve,
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort!),
      });
    });
    this.#bridge.send({
      kind: "getToolsRequest",
      requestId,
      fromOrigins: options.fromOrigins?.map(String),
      forOrigin: typeof location !== "undefined" ? location.origin : "unknown",
    });
    return promise.finally(() => this.#getToolsPending.get(requestId)?.cleanup?.());
  }

  /**
   * In-page-agent entry point (spec: a caller may invoke another document's
   * tool). The host routes the call to the owning frame.
   */
  async executeTool(
    tool: { name: string } | PublicRegisteredTool,
    inputObject: Record<string, unknown> = {},
    options: ModelContextExecuteToolOptions = {},
  ): Promise<string> {
    this.#assertAlive();
    if (options.signal?.aborted) throw abortError();
    const requestId = randomId("ex");
    const promise = new Promise<string>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      if (options.signal) {
        if (options.signal.aborted) {
          reject(abortError());
          return;
        }
        onAbort = () => {
          this.#executeForwardPending.delete(requestId);
          this.#bridge.send({ kind: "cancelForward", requestId });
          reject(abortError());
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#executeForwardPending.set(requestId, {
        resolve,
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort!),
      });
    });
    this.#bridge.send({
      kind: "executeForward",
      requestId,
      name: tool.name,
      input: inputObject ?? {},
      fromOrigin: typeof location !== "undefined" ? location.origin : "unknown",
    });
    return promise.finally(() => this.#executeForwardPending.get(requestId)?.cleanup?.());
  }

  /**
   * webdesktopmcp extension: explicit removal. The W3C draft only offers
   * AbortSignal-based unregistration, which is awkward for the declarative
   * form API and for dynamic UIs.
   */
  async unregisterTool(name: string): Promise<void> {
    this.#assertAlive();
    if (!this.#localTools.has(name)) {
      throw domError("NotFoundError", `No tool named "${name}" is registered in this document.`);
    }
    this.#forgetLocal(name);
    this.#bridge.send({ kind: "unregister", invocationId: randomId("unreg"), name });
  }

  get ontoolchange(): ((event: Event) => void) | null {
    return (this as unknown as { _ontoolchange: ((e: Event) => void) | null })._ontoolchange ?? null;
  }

  set ontoolchange(handler: ((event: Event) => void) | null) {
    (this as unknown as { _ontoolchange: ((e: Event) => void) | null })._ontoolchange = handler;
    this.removeEventListener("toolchange", this.#onToolChangeBridge);
    if (handler) this.addEventListener("toolchange", this.#onToolChangeBridge);
  }

  readonly #onToolChangeBridge = (e: Event) => {
    const h = (this as unknown as { _ontoolchange: ((ev: Event) => void) | null })._ontoolchange;
    h?.(e);
  };

  // -- Host-driven execution (this frame owns the tool) ----------------------

  /** @internal Called by the installer when the host requests execution. */
  async handleHostExecute(invocationId: string, name: string, input: unknown): Promise<void> {
    const entry = this.#localTools.get(name);
    if (!entry || this.#disposed) {
      this.#bridge.send({
        kind: "executeResult",
        invocationId,
        ok: false,
        errorCode: "NotFoundError",
        errorMessage: `Tool "${name}" is not registered in this frame.`,
      });
      return;
    }
    const controller = new AbortController();
    this.#invocations.set(invocationId, controller);
    try {
      const safeInput = isObject(input) ? input : {};
      const result = await entry.declaration.execute(safeInput, { signal: controller.signal });
      let serialised: string;
      try {
        serialised = JSON.stringify(result ?? null);
      } catch {
        throw new Error("Tool result is not JSON-serialisable.");
      }
      this.#bridge.send({ kind: "executeResult", invocationId, ok: true, result: serialised });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log("warn", `Tool "${name}" execution failed: ${message}`);
      this.#bridge.send({
        kind: "executeResult",
        invocationId,
        ok: false,
        errorCode:
          (err as { name?: string } | null)?.name === "AbortError" ? "AbortError" : "ExecutionError",
        errorMessage: message,
      });
    } finally {
      this.#invocations.delete(invocationId);
    }
  }

  /** @internal */
  handleHostAbort(invocationId: string): void {
    this.#invocations.get(invocationId)?.abort();
  }

  /** @internal */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const name of [...this.#localTools.keys()]) {
      this.#forgetLocal(name);
      this.#bridge.send({ kind: "unregister", invocationId: randomId("unreg"), name });
    }
    for (const requestId of this.#executeForwardPending.keys()) {
      this.#bridge.send({ kind: "cancelForward", requestId });
    }
    this.#unsub();
    for (const p of this.#registerPending.values()) p.reject(abortError());
    for (const p of this.#getToolsPending.values()) { p.cleanup?.(); p.reject(abortError()); }
    for (const p of this.#executeForwardPending.values()) { p.cleanup?.(); p.reject(abortError()); }
    this.#registerPending.clear();
    this.#getToolsPending.clear();
    this.#executeForwardPending.clear();
    for (const c of this.#invocations.values()) c.abort();
    this.#invocations.clear();
    this.#localTools.clear();
  }

  /** @internal */
  get registeredToolNames(): readonly string[] {
    return [...this.#localTools.keys()];
  }

  /** @internal */
  findLocal(name: string): LocalTool | undefined {
    return this.#localTools.get(name);
  }

  // -- internals -------------------------------------------------------------

  #assertAlive(): void {
    if (this.#disposed) throw domError("InvalidStateError", "The model context has been disposed.");
  }

  #forgetLocal(name: string): void {
    const entry = this.#localTools.get(name);
    entry?.cleanup?.();
    if (entry) {
      const pending = this.#registerPending.get(entry.registrationId);
      this.#registerPending.delete(entry.registrationId);
      pending?.reject(abortError());
    }
    if (this.#localTools.delete(name)) {
      this.dispatchEvent(new Event("toolchange"));
    }
  }

  #onHostMessage(msg: Record<string, unknown>): void {
    switch (msg.kind) {
      case "registerResult": {
        const pending = this.#registerPending.get(msg.invocationId as string);
        if (!pending) return;
        this.#registerPending.delete(msg.invocationId as string);
        if (msg.ok) {
          this.dispatchEvent(new Event("toolchange"));
          pending.resolve(undefined);
        } else {
          // Cross-frame name clash or host rejection: roll back the optimistic entry.
          this.#forgetLocal(pending.toolName);
          pending.reject(
            domError("InvalidStateError", String(msg.errorMessage ?? "Registration rejected.")),
          );
        }
        break;
      }
      case "getToolsResponse": {
        const pending = this.#getToolsPending.get(msg.requestId as string);
        if (!pending) return;
        this.#getToolsPending.delete(msg.requestId as string);
        pending.cleanup?.();
        pending.resolve((msg.tools as RegisteredToolInfo[]).map(toPublicTool));
        break;
      }
      case "executeForwardResult": {
        const pending = this.#executeForwardPending.get(msg.requestId as string);
        if (!pending) return;
        this.#executeForwardPending.delete(msg.requestId as string);
        pending.cleanup?.();
        if (msg.ok) pending.resolve(String(msg.result ?? "null"));
        else
          pending.reject(
            domError(String(msg.errorCode ?? "ExecutionError"), String(msg.errorMessage ?? "")),
          );
        break;
      }
      case "execute":
        void this.handleHostExecute(msg.invocationId as string, msg.name as string, msg.input);
        break;
      case "abort":
        this.handleHostAbort(msg.invocationId as string);
        break;
      case "toolsChanged":
        this.#remoteTools = (msg.tools as RegisteredToolInfo[]) ?? [];
        this.dispatchEvent(new Event("toolchange"));
        break;
      default:
        break;
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toPublicTool(info: RegisteredToolInfo): PublicRegisteredTool {
  return {
    name: info.name,
    title: info.title,
    description: info.description,
    inputSchema: info.inputSchema,
    annotations: info.annotations,
    origin: info.origin,
    frameId: info.frameId,
  };
}

/** Internal bookkeeping the declarative layer needs from the installed context. */
export interface PolyfillInternals {
  modelContext: ModelContext;
  frameId: string;
  protocolVersion: number;
}

/**
 * Install the polyfill onto `document`. Skips when a native implementation
 * already exists or the context is insecure (unless `force`).
 */
export function installModelContextPolyfill(
  options: PolyfillInstallOptions,
): InstalledPolyfill | null {
  const log = options.log ?? (() => {});
  const doc = typeof document !== "undefined" ? document : undefined;
  if (!doc) {
    log("warn", "[webdesktopmcp] No `document` — not installing.");
    return null;
  }
  if ("modelContext" in doc && !options.force) {
    log("info", "[webdesktopmcp] Native WebMCP detected — polyfill not installed.");
    return null;
  }
  if (!globalThis.isSecureContext && !options.force) {
    log("warn", "[webdesktopmcp] Insecure context and `force` not set — not installing.");
    return null;
  }

  const original = Object.getOwnPropertyDescriptor(doc, "modelContext");
  const mc = new ModelContext(options.bridge, options.frameId, log);
  Object.defineProperty(doc, "modelContext", {
    value: mc,
    enumerable: true,
    configurable: true,
    writable: false,
  });

  const internals: PolyfillInternals = {
    modelContext: mc,
    frameId: options.frameId,
    protocolVersion: PROTOCOL_VERSION,
  };
  (globalThis as unknown as Record<string, unknown>).__webDesktopMcp = {
    version: PROTOCOL_VERSION,
    mode: "polyfill",
    internals,
    // Console debug helper: __webDesktopMcp.listTools()
    listTools: () =>
      mc.registeredToolNames.map((name) => {
        const entry = mc.findLocal(name);
        return {
          name,
          description: entry?.declaration.description ?? "",
          inputSchema: entry?.declaration.inputSchema,
        };
      }),
  };

  const declarativeDispose =
    options.declarative !== false ? setupDeclarativeApi(mc, log) : undefined;

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      declarativeDispose?.();
      mc.dispose();
      if (original) Object.defineProperty(doc, "modelContext", original);
      else delete (doc as unknown as Record<string, unknown>).modelContext;
      delete (globalThis as unknown as Record<string, unknown>).__webDesktopMcp;
    },
    get registeredToolNames() {
      return mc.registeredToolNames;
    },
  };
}

export type { InstalledPolyfill, PolyfillInstallOptions };
