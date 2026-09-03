/**
 * In-memory tool registry shared by every host implementation (Electron uses
 * it directly; Tauri/Wails re-implement it natively against docs/protocol.md).
 *
 * Enforces app-wide unique tool names — the W3C draft keeps names unique per
 * document; desktop apps usually have one MCP namespace per app, so we reject
 * collisions across frames instead of shadowing them.
 */

import type { RegisteredToolInfo, ToolDeclaration } from "@webdesktopmcp/protocol";

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
      resolve: (result: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  readonly #changeCallbacks = new Set<() => void>();
  readonly #forwardPending = new Map<
    string,
    { callerFrameId: string; requestId: string; timeout: NodeJS.Timeout }
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
  handleRegister(frameId: string, invocationId: string, tool: ToolDeclaration, exposedTo?: string[]): RegisterOutcome {
    const outcome = this.#add(frameId, tool, exposedTo);
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
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: "${name}". The app page may have unregistered it.`);

    const invocationId = `inv-${this.#nextInvocationId++}`;
    const promise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingInvocations.delete(invocationId);
        reject(
          new Error(
            `Tool "${name}" timed out after ${this.options.invocationTimeoutMs ?? 120_000}ms (no response from the app webview).`,
          ),
        );
      }, this.options.invocationTimeoutMs ?? 120_000);
      this.#pendingInvocations.set(invocationId, { resolve, reject, timeout });
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
    invocationId: string,
    ok: boolean,
    result?: string,
    errorCode?: string,
    errorMessage?: string,
  ): void {
    const pending = this.#pendingInvocations.get(invocationId);
    if (pending) {
      this.#pendingInvocations.delete(invocationId);
      clearTimeout(pending.timeout);
      if (ok) pending.resolve(result ?? "null");
      else pending.reject(new Error(errorMessage ?? errorCode ?? "Tool execution failed."));
      return;
    }
    const forwarded = this.#forwardPending.get(invocationId);
    if (forwarded) {
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
      if (fromOrigins && fromOrigins.length > 0 && !fromOrigins.includes(t.origin)) return false;
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
    if (tool.frameId === callerFrameId) {
      // Same frame: the local polyfill would have executed directly; treat as
      // unreachable but respond cleanly.
      return fail("InvalidStateError", `Tool "${name}" belongs to the calling frame.`);
    }
    if (!isExposedTo(tool, fromOrigin)) {
      return fail("SecurityError", `Tool "${name}" is not exposed to origin "${fromOrigin}".`);
    }
    const invocationId = `fwd-${this.#nextForwardId++}`;
    const timeout = setTimeout(() => {
      this.#forwardPending.delete(invocationId);
      fail("TimeoutError", `Forwarded call to "${name}" timed out.`);
    }, this.options.invocationTimeoutMs ?? 120_000);
    this.#forwardPending.set(invocationId, { callerFrameId, requestId, timeout });
    this.adapter.sendToFrame(tool.frameId, { kind: "execute", invocationId, name, input });
  }

  #add(frameId: string, tool: ToolDeclaration, exposedTo?: string[]): RegisterOutcome {
    if (this.#tools.has(tool.name)) {
      const owner = this.#tools.get(tool.name)!.frameId;
      if (owner === frameId) {
        // Same frame re-registering: spec says reject (unique per document).
        return { ok: false, errorMessage: `Tool "${tool.name}" is already registered in this frame.` };
      }
      return {
        ok: false,
        errorMessage: `Tool name "${tool.name}" is already used by another webview (frame "${owner}"). Tool names must be unique within the app.`,
      };
    }
    this.#tools.set(tool.name, {
      ...tool,
      ...(exposedTo && exposedTo.length > 0 ? { exposedTo } : {}),
      frameId,
      origin: "",
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
  if (!tool.exposedTo || tool.exposedTo.length === 0) return true;
  return tool.exposedTo.includes(origin);
}
