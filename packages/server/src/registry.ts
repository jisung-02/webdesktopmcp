/**
 * In-memory tool registry shared by every host implementation (Electron uses
 * it directly; Tauri/Wails re-implement it natively against docs/protocol.md).
 *
 * Enforces app-wide unique tool names — the W3C draft keeps names unique per
 * document; desktop apps usually have one MCP namespace per app, so we reject
 * collisions across frames instead of shadowing them.
 */

import { validateToolDeclaration, type RegisteredToolInfo, type ToolDeclaration } from "@webdesktopmcp/protocol";

export interface InvokeRequest {
  frameId: string;
  name: string;
  input: unknown;
  /** Resolved by the host adapter; wire the MCP client cancellation here. */
  signal: AbortSignal;
}

/**
 * The host adapter plugs frame communication into this interface.
 * The server package owns everything above it (MCP protocol, HTTP, auth).
 */
export interface HostAdapter {
  /** Send a message to a specific frame/webview. */
  sendToFrame(frameId: string, message: unknown): void;
  /** Called by the adapter to notify the registry when a frame is gone. */
  onFrameGone(cb: (frameId: string) => void): void;
}

export interface RegisterOutcome {
  ok: boolean;
  errorMessage?: string;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredToolInfo>();
  readonly #pendingInvocations = new Map<
    string,
    {
      frameId: string;
      resolve: (result: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  readonly #changeCallbacks = new Set<() => void>();
  readonly #forwardPending = new Map<
    string,
    { frameId: string; callerFrameId: string; requestId: string; timeout: NodeJS.Timeout }
  >();
  #nextInvocationId = 1;
  #nextForwardId = 1;

  constructor(
    private readonly adapter: HostAdapter,
    private readonly options: {
      /** Per-invocation timeout in ms. Default 120s. */
      invocationTimeoutMs?: number;
    } = {},
  ) {
    adapter.onFrameGone((frameId) => this.removeFrame(frameId));
  }

  list(): RegisteredToolInfo[] {
    return [...this.#tools.values()];
  }

  get(name: string): RegisteredToolInfo | undefined {
    return this.#tools.get(name);
  }

  /**
   * Handle a `register` message from a frame. Replies `registerResult`
   * to the frame and notifies MCP clients.
   */
  handleRegister(frameId: string, invocationId: string, tool: ToolDeclaration, exposedTo?: string[], origin = ""): RegisterOutcome {
    let outcome: RegisterOutcome;
    try {
      outcome = this.#add(frameId, validateToolDeclaration(tool), exposedTo, origin);
    } catch (error) {
      outcome = { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
    this.adapter.sendToFrame(frameId, {
      kind: "registerResult",
      invocationId,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { errorMessage: outcome.errorMessage }),
    });
    if (outcome.ok) this.#emitChange();
    return outcome;
  }

  handleUnregister(frameId: string, name: string): void {
    const existing = this.#tools.get(name);
    if (existing && existing.frameId === frameId) {
      this.#tools.delete(name);
      this.#emitChange();
    }
  }

  removeFrame(frameId: string): void {
    let changed = false;
    for (const [name, info] of this.#tools) {
      if (info.frameId === frameId) {
        this.#tools.delete(name);
        changed = true;
      }
    }
    for (const [id, pending] of this.#pendingInvocations) {
      if (pending.frameId !== frameId) continue;
      this.#pendingInvocations.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new Error("The tool's document/frame disappeared."));
      this.adapter.sendToFrame(frameId, { kind: "abort", invocationId: id });
    }
    for (const [id, pending] of this.#forwardPending) {
      if (pending.frameId === frameId || pending.callerFrameId === frameId) {
        this.#cancelForward(id, "AbortError", "A participating document/frame disappeared.");
      }
    }
    if (changed) this.#emitChange();
  }

  onToolsChanged(cb: () => void): () => void {
    this.#changeCallbacks.add(cb);
    return () => this.#changeCallbacks.delete(cb);
  }

  /**
   * Route a tool call from an MCP client to the owning frame and await the
   * renderer's result. Rejects with a descriptive Error on failure.
   */
  async invoke(name: string, input: unknown, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("Tool invocation was cancelled.");
    const tool = this.#tools.get(name);
    if (tool?.exposedTo?.length) throw new Error("Tool is reserved for in-page agents (exposedTo).");
    if (!tool) throw new Error(`Unknown tool: "${name}". The app page may have unregistered it.`);

    const invocationId = `inv-${this.#nextInvocationId++}`;
    const promise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingInvocations.delete(invocationId);
        this.adapter.sendToFrame(tool.frameId, { kind: "abort", invocationId });
        reject(
          new Error(
            `Tool "${name}" timed out after ${this.options.invocationTimeoutMs ?? 120_000}ms (no response from the app webview).`,
          ),
        );
      }, this.options.invocationTimeoutMs ?? 120_000);
      this.#pendingInvocations.set(invocationId, { frameId: tool.frameId, resolve, reject, timeout });
    });

    const onAbort = () => {
      const pending = this.#pendingInvocations.get(invocationId);
      if (pending) {
        this.#pendingInvocations.delete(invocationId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Tool "${name}" invocation was cancelled.`));
      }
      this.adapter.sendToFrame(tool.frameId, { kind: "abort", invocationId });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    this.adapter.sendToFrame(tool.frameId, {
      kind: "execute",
      invocationId,
      name,
      input: input ?? {},
    });

    try {
      return await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Handle an `executeResult` message from a frame. */
  handleExecuteResult(
    frameId: string,
    invocationId: string,
    ok: boolean,
    result?: string,
    errorCode?: string,
    errorMessage?: string,
  ): void {
    const pending = this.#pendingInvocations.get(invocationId);
    if (pending && pending.frameId === frameId) {
      this.#pendingInvocations.delete(invocationId);
      clearTimeout(pending.timeout);
      if (ok) pending.resolve(result ?? "null");
      else pending.reject(new Error(errorMessage ?? errorCode ?? "Tool execution failed."));
      return;
    }
    const forwarded = this.#forwardPending.get(invocationId);
    if (forwarded && forwarded.frameId === frameId) {
      this.#forwardPending.delete(invocationId);
      clearTimeout(forwarded.timeout);
      this.adapter.sendToFrame(forwarded.callerFrameId, {
        kind: "executeForwardResult",
        requestId: forwarded.requestId,
        ok,
        ...(ok ? { result: result ?? "null" } : { errorCode, errorMessage }),
      });
    }
  }

  /** Handle `getToolsRequest` from an in-page agent (cross-frame surface). */
  handleGetToolsRequest(
    frameId: string,
    requestId: string,
    forOrigin: string,
    fromOrigins?: string[],
  ): void {
    const tools = this.list().filter((t) => {
      if (t.frameId === frameId) return true;
      if (t.origin !== forOrigin && !fromOrigins?.includes(t.origin)) return false;
      return isExposedTo(t, forOrigin);
    });
    this.adapter.sendToFrame(frameId, { kind: "getToolsResponse", requestId, tools });
  }

  /**
   * Handle `executeForward`: an in-page agent (frame A) invoking another
   * frame's tool. Enforces `exposedTo`, routes to the owner, and returns the
   * result to the caller as `executeForwardResult`.
   */
  handleExecuteForward(
    callerFrameId: string,
    requestId: string,
    name: string,
    input: unknown,
    fromOrigin: string,
  ): void {
    const fail = (errorCode: string, errorMessage: string) => {
      this.adapter.sendToFrame(callerFrameId, {
        kind: "executeForwardResult",
        requestId,
        ok: false,
        errorCode,
        errorMessage,
      });
    };
    const tool = this.#tools.get(name);
    if (!tool) return fail("NotFoundError", `Tool "${name}" is not registered.`);
    if (tool.frameId !== callerFrameId && !isExposedTo(tool, fromOrigin)) {
      return fail("SecurityError", `Tool "${name}" is not exposed to origin "${fromOrigin}".`);
    }
    if ([...this.#forwardPending.values()].some(p => p.callerFrameId === callerFrameId && p.requestId === requestId)) {
      return fail("InvalidStateError", "A call with this requestId is already pending.");
    }
    const invocationId = `fwd-${this.#nextForwardId++}`;
    const timeout = setTimeout(() => {
      this.#cancelForward(invocationId, "TimeoutError", `Forwarded call to "${name}" timed out.`);
    }, this.options.invocationTimeoutMs ?? 120_000);
    this.#forwardPending.set(invocationId, { frameId: tool.frameId, callerFrameId, requestId, timeout });
    this.adapter.sendToFrame(tool.frameId, { kind: "execute", invocationId, name, input });
  }

  handleCancelForward(callerFrameId: string, requestId: string): void {
    for (const [id, pending] of this.#forwardPending) {
      if (pending.callerFrameId === callerFrameId && pending.requestId === requestId) {
        this.#cancelForward(id, "AbortError", "Tool invocation was cancelled.");
      }
    }
  }

  #cancelForward(invocationId: string, errorCode: string, errorMessage: string): void {
    const pending = this.#forwardPending.get(invocationId);
    if (!pending) return;
    this.#forwardPending.delete(invocationId);
    clearTimeout(pending.timeout);
    this.adapter.sendToFrame(pending.frameId, { kind: "abort", invocationId });
    this.adapter.sendToFrame(pending.callerFrameId, {
      kind: "executeForwardResult", requestId: pending.requestId, ok: false, errorCode, errorMessage,
    });
  }

  #add(frameId: string, tool: ToolDeclaration, exposedTo?: string[], origin = ""): RegisterOutcome {
    const existing = this.#tools.get(tool.name);
    if (existing && existing.frameId !== frameId) {
      return {
        ok: false,
        errorMessage: `Tool name "${tool.name}" is already used by another webview (frame "${existing.frameId}"). Tool names must be unique within the app.`,
      };
    }
    // Same-frame re-register REPLACES the entry: the page reloads / navigates
    // and re-registers the same names (the W3C uniqueness rule is per
    // document and the polyfill enforces it locally; the host must not strand
    // a frame whose document changed underneath it).
    this.#tools.set(tool.name, {
      ...tool,
      ...(exposedTo && exposedTo.length > 0 ? { exposedTo } : {}),
      frameId,
      origin,
    });
    return { ok: true };
  }

  /** Stamp origin after the adapter resolves it (keeps registry frame-agnostic). */
  setOrigin(name: string, origin: string): void {
    const t = this.#tools.get(name);
    if (t) t.origin = origin;
  }

  #emitChange(): void {
    for (const cb of [...this.#changeCallbacks]) cb();
  }
}

export function isExposedTo(tool: RegisteredToolInfo, origin: string): boolean {
  if (!origin || origin === "null") return false;
  return tool.origin === origin || !!tool.exposedTo?.includes(origin);
}
