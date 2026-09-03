/*!
 * webdesktopmcp — Wails bootstrap script (ES2020, page main world).
 *
 * Injected via Server.InitScript() (also served at GET /webdesktopmcp.js) and
 * pairs with the Go host github.com/webdesktopmcp/go-webdesktopmcp. It exposes
 * window.__webDesktopMcpHost { send(msg), _deliver(msg) } and then either:
 *   - native mirror: the runtime already ships WebMCP (`document.modelContext`)
 *     → wrap registerTool to mirror registrations to the Go host and route
 *     external execute/abort into the captured callbacks; or
 *   - polyfill: install document.modelContext implementing the W3C WebMCP
 *     draft semantics (registerTool/unregisterTool/getTools/executeTool/
 *     ontoolchange, AbortSignal lifetime rules).
 *
 * Declarative registration forms (HTML attributes / <script type="tool">) are
 * NOT implemented here — the TypeScript core (@webdesktopmcp/core) has them.
 *
 * Cross-window delivery: wails EventsEmit broadcasts to every window, so every
 * frame sees every host message. Each frame filters by ownership: host execute
 * ids embed the target frame ("inv-<frame>-<n>", "fwd-<frame>-<n>"), and
 * replies (registerResult/getToolsResponse/executeForwardResult) are matched
 * against this frame's pending maps, so stray messages are ignored.
 */
(() => {
  "use strict";
  if (typeof window === "undefined" || window.__webDesktopMcpHost) return;

  const EVENT_NAME = "webdesktopmcp:message";
  const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

  // -- frame identity -------------------------------------------------------

  const frameId = () => {
    try {
      const rt = window.runtime;
      const n = rt && typeof rt.WindowName === "function" ? rt.WindowName() : null;
      if (n !== null && n !== undefined && n !== "") return String(n);
    } catch (e) { /* wails runtime not ready */ }
    return "main";
  };

  // Per-page-load session token: lets the Go host prune this frame's stale
  // tools when the page reloads (Wails reloads never call FrameGone).
  const SESSION = "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

  const uid = (prefix) =>
    frameId() + "-" + prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  const pageOrigin = () => (typeof location === "object" ? String(location.origin) : "");

  // -- pending maps (reply routing) ------------------------------------------

  const pendingReg = new Map();  // invocationId -> { toolName, resolve, reject }
  const pendingGet = new Map();  // requestId    -> { resolve, reject }
  const pendingFwd = new Map();  // requestId    -> { resolve, reject }
  const localTools = new Map();  // name -> execute fn (polyfill mode)
  const invocations = new Map(); // invocationId -> AbortController
  const mirrored = new Map();    // name -> execute fn (native-mirror mode)
  const mirrorInvs = new Map();  // invocationId -> AbortController

  // -- helpers ----------------------------------------------------------------

  function domError(name, message) {
    if (typeof DOMException === "function") return new DOMException(message, name);
    const err = new Error(message);
    err.name = name;
    return err;
  }

  function validateDeclaration(tool) {
    if (!tool || typeof tool !== "object") throw new TypeError("Tool must be an object.");
    if (typeof tool.name !== "string" || !NAME_RE.test(tool.name)) {
      throw new TypeError("Invalid tool name: must be 1-128 characters of [A-Za-z0-9_.-], got " + JSON.stringify(tool.name) + ".");
    }
    if (typeof tool.description !== "string" || tool.description.length === 0) {
      throw new TypeError('Tool "' + tool.name + '": description is required and must be a non-empty string.');
    }
    if (tool.inputSchema !== undefined && tool.inputSchema !== null) {
      if (typeof tool.inputSchema !== "object" || typeof tool.inputSchema.type !== "string") {
        throw new TypeError('Tool "' + tool.name + '": inputSchema must be a JSON Schema object with a string "type".');
      }
    }
    if (tool.annotations !== undefined && tool.annotations !== null && typeof tool.annotations !== "object") {
      throw new TypeError('Tool "' + tool.name + '": annotations must be an object.');
    }
  }

  const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

  function serialise(result) {
    try {
      return JSON.stringify(result === undefined ? null : result);
    } catch (e) {
      throw new Error("Tool result is not JSON-serialisable.");
    }
  }

  // -- host bridge -------------------------------------------------------------

  const host = {
    /** Page → host. Fire-and-forget; the ack only reports transport errors. */
    send(msg) {
      const target = window.go && window.go.webdesktopmcp && window.go.webdesktopmcp.Server;
      if (!target || typeof target.Send !== "function") {
        console.warn("[webdesktopmcp] window.go.webdesktopmcp.Server is unavailable; message dropped.");
        return;
      }
      try {
        const p = target.Send(String(frameId()), isPlainObject(msg) ? msg : {});
        if (p && typeof p.catch === "function") p.catch((err) => console.warn("[webdesktopmcp] Send failed:", err));
      } catch (err) {
        console.warn("[webdesktopmcp] Send failed:", err);
      }
    },
    /** Host → page (also wired to wails EventsOn below). */
    _deliver(msg) { onHostMessage(msg); },
  };
  window.__webDesktopMcpHost = host;

  const toHost = (msg) => host.send(msg);

  // -- native WebMCP mirror ------------------------------------------------------

  const hasNative =
    typeof document === "object" && document !== null &&
    "modelContext" in document &&
    document.modelContext !== null && document.modelContext !== undefined &&
    typeof document.modelContext.registerTool === "function";

  if (hasNative) {
    const nativeMC = document.modelContext;
    const callOriginal = nativeMC.registerTool.bind(nativeMC);
    nativeMC.registerTool = function wrappedRegisterTool(tool, options) {
      try {
        if (tool && typeof tool === "object" && typeof tool.name === "string") {
          mirrored.set(tool.name, typeof tool.execute === "function" ? tool.execute : null);
          toHost({
            kind: "register",
            invocationId: uid("mirror"),
            tool: {
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : "",
              inputSchema: tool.inputSchema,
              annotations: tool.annotations,
            },
            exposedTo: options && Array.isArray(options.exposedTo) ? options.exposedTo.map(String) : undefined,
            _session: SESSION,
            _origin: pageOrigin(),
          });
        }
      } catch (err) { /* mirroring is best-effort; never break native registration */ }
      return callOriginal(tool, options);
    };
    try {
      Object.defineProperty(nativeMC.registerTool, "name", { value: "registerTool", configurable: true });
    } catch (e) { /* cosmetic */ }
  }

  // -- host message dispatch ------------------------------------------------------

  const toPublicTool = (info) => ({
    name: info.name, title: info.title, description: info.description,
    inputSchema: info.inputSchema, annotations: info.annotations,
    origin: info.origin, frameId: info.frameId,
  });

  async function runTool(invID, name, input) {
    const fn = hasNative ? mirrored.get(name) : localTools.get(name);
    if (typeof fn !== "function") return; // not ours — another frame owns this tool
    const controller = new AbortController();
    const tracking = hasNative ? mirrorInvs : invocations;
    tracking.set(invID, controller);
    try {
      const result = await fn(isPlainObject(input) ? input : {}, { signal: controller.signal });
      toHost({ kind: "executeResult", invocationId: invID, ok: true, result: serialise(result) });
    } catch (err) {
      toHost({
        kind: "executeResult", invocationId: invID, ok: false,
        errorCode: err && err.name === "AbortError" ? "AbortError" : "ExecutionError",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tracking.delete(invID);
    }
  }

  function onHostMessage(raw) {
    if (!isPlainObject(raw)) return;
    const kind = raw.kind;
    if (kind === "execute") {
      const fid = frameId();
      const invID = String(raw.invocationId || "");
      if (!invID.startsWith("inv-" + fid + "-") && !invID.startsWith("fwd-" + fid + "-")) return;
      runTool(invID, String(raw.name || ""), raw.input);
      return;
    }
    if (kind === "abort") {
      const controller = invocations.get(String(raw.invocationId || "")) || mirrorInvs.get(String(raw.invocationId || ""));
      if (controller) controller.abort();
      return;
    }
    if (kind === "registerResult") {
      const id = String(raw.invocationId || "");
      const entry = pendingReg.get(id);
      if (!entry) return;
      pendingReg.delete(id);
      if (raw.ok) entry.resolve(undefined);
      else {
        forgetLocal(entry.toolName); // roll back the optimistic registration
        entry.reject(domError("InvalidStateError", String(raw.errorMessage || "Registration rejected.")));
      }
      return;
    }
    if (kind === "getToolsResponse") {
      const id = String(raw.requestId || "");
      const entry = pendingGet.get(id);
      if (!entry) return;
      pendingGet.delete(id);
      entry.resolve(Array.isArray(raw.tools) ? raw.tools.map(toPublicTool) : []);
      return;
    }
    if (kind === "executeForwardResult") {
      const id = String(raw.requestId || "");
      const entry = pendingFwd.get(id);
      if (!entry) return;
      pendingFwd.delete(id);
      if (raw.ok) entry.resolve(String(raw.result === undefined || raw.result === null ? "null" : raw.result));
      else entry.reject(domError(String(raw.errorCode || "ExecutionError"), String(raw.errorMessage || "")));
      return;
    }
    // "toolsChanged" / "log" / unknown kinds: nothing to do here.
  }

  // -- polyfill ---------------------------------------------------------------------

  let mc = null;
  function mcDispatchToolChange() { if (mc) mc.dispatchEvent(new Event("toolchange")); }

  function forgetLocal(name) {
    if (localTools.delete(name)) mcDispatchToolChange();
  }

  function installPolyfill() {
    class ModelContext extends EventTarget {
      async registerTool(tool, options) {
        const opts = options || {};
        validateDeclaration(tool);
        if (typeof tool.execute !== "function") {
          throw domError("InvalidStateError", 'Tool "' + tool.name + '": execute must be a function.');
        }
        if (localTools.has(tool.name)) {
          throw domError("InvalidStateError", 'A tool named "' + tool.name + '" is already registered in this document.');
        }
        const exposedTo = Array.isArray(opts.exposedTo) ? opts.exposedTo.map(String) : undefined;
        const invocationId = uid("reg");
        const promise = new Promise((resolve, reject) => {
          pendingReg.set(invocationId, { toolName: tool.name, resolve, reject });
        });
        if (opts.signal) {
          const signal = opts.signal;
          if (signal.aborted) {
            pendingReg.delete(invocationId);
            return Promise.reject(domError("AbortError", "The operation was aborted."));
          }
          // W3C semantics: the signal owns the tool's whole lifetime — abort
          // while pending fails + rolls back; abort after registration
          // unregisters the tool.
          signal.addEventListener("abort", () => {
            const pending = pendingReg.get(invocationId);
            if (pending) {
              pendingReg.delete(invocationId);
              pending.reject(domError("AbortError", "The operation was aborted."));
              forgetLocal(tool.name);
            } else if (localTools.has(tool.name)) {
              forgetLocal(tool.name);
              toHost({ kind: "unregister", invocationId: uid("unreg"), name: tool.name });
            }
          }, { once: true });
        }
        localTools.set(tool.name, tool.execute);
        toHost({
          kind: "register", invocationId,
          tool: {
            name: tool.name,
            title: typeof tool.title === "string" ? tool.title : undefined,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
          exposedTo: exposedTo && exposedTo.length > 0 ? exposedTo : undefined,
          _session: SESSION,
          _origin: pageOrigin(),
        });
        return promise;
      }

      /** webdesktopmcp extension: explicit removal (the W3C draft only offers
       * AbortSignal-based unregistration). */
      async unregisterTool(name) {
        if (!localTools.has(name)) {
          throw domError("NotFoundError", 'No tool named "' + name + '" is registered in this document.');
        }
        forgetLocal(name);
        toHost({ kind: "unregister", invocationId: uid("unreg"), name: String(name) });
      }

      /** Cross-frame tool list (remote surface for in-page agents). */
      async getTools(options) {
        const opts = options || {};
        const requestId = uid("gt");
        const promise = new Promise((resolve, reject) => pendingGet.set(requestId, { resolve, reject }));
        toHost({
          kind: "getToolsRequest", requestId,
          fromOrigins: Array.isArray(opts.fromOrigins) ? opts.fromOrigins.map(String) : undefined,
          forOrigin: pageOrigin(),
        });
        return promise;
      }

      /** Cross-frame execution: the host routes to the owning frame. */
      async executeTool(tool, inputObject, options) {
        const opts = options || {};
        if (opts.signal && opts.signal.aborted) {
          return Promise.reject(domError("AbortError", "The operation was aborted."));
        }
        const requestId = uid("ex");
        const promise = new Promise((resolve, reject) => pendingFwd.set(requestId, { resolve, reject }));
        if (opts.signal) {
          const onAbort = () => {
            if (pendingFwd.delete(requestId)) reject(domError("AbortError", "The operation was aborted."));
          };
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        toHost({
          kind: "executeForward", requestId,
          name: String(tool && tool.name),
          input: isPlainObject(inputObject) ? inputObject : {},
          fromOrigin: pageOrigin(),
        });
        return promise;
      }

      get ontoolchange() { return this._ontoolchange || null; }
      set ontoolchange(handler) {
        this.removeEventListener("toolchange", this._boundChange);
        this._ontoolchange = handler || null;
        if (handler) {
          if (!this._boundChange) {
            this._boundChange = (e) => { if (this._ontoolchange) this._ontoolchange(e); };
          }
          this.addEventListener("toolchange", this._boundChange);
        }
      }
    }

    mc = new ModelContext();
    Object.defineProperty(document, "modelContext", {
      value: mc, enumerable: true, configurable: true, writable: false,
    });
  }

  // -- wails runtime event subscription ------------------------------------------------

  let subscribed = false;
  function subscribe() {
    if (subscribed) return true;
    const rt = window.runtime;
    if (rt && typeof rt.EventsOn === "function") {
      subscribed = true;
      rt.EventsOn(EVENT_NAME, (msg) => onHostMessage(msg));
      return true;
    }
    return false;
  }
  if (!subscribe()) {
    // window.runtime may load after this script (e.g. injected via <head>);
    // poll briefly before giving up.
    let tries = 0;
    const timer = setInterval(() => {
      if (subscribe() || ++tries > 150) clearInterval(timer);
    }, 200);
  }

  if (!hasNative && typeof document === "object" && document !== null) {
    // Note: the TS core gates on isSecureContext; embedded wails pages are
    // trusted loopback content, so we always install here.
    installPolyfill();
  }

  window.__webDesktopMcp = { version: 1, mode: hasNative ? "native-mirror" : "polyfill" };
})();
