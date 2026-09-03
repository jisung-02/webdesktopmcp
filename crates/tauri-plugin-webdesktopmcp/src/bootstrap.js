/*!
 * webdesktopmcp bootstrap — injected into every webview's MAIN world.
 *
 * Installs `window.__webDesktopMcpHost` (wire protocol v1 over Tauri IPC,
 * see docs/protocol.md) and then either:
 *   1. mirrors an already-native `document.modelContext` (WebMCP-capable
 *      runtime) to the host — the page keeps using the native API, or
 *   2. polyfills `document.modelContext` on top of the bridge.
 *
 * NOTE: the declarative HTML form API (`<tool>` elements) is intentionally
 * NOT implemented in this embedded script — the TS core
 * (`@webdesktopmcp/core`) owns it. Only the programmatic
 * registerTool/unregisterTool/getTools/executeTool surface lives here.
 *
 * The script is idempotent (safe to inject on both page-load edges and via
 * `initialization_script`), targets ES2020, and has no build step.
 */
(function () {
  'use strict';
  if (window.__webDesktopMcpHost) return;

  var TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
  var IPC_COMMAND = 'plugin:webdesktopmcp|send';
  var subscribers = [];

  // ---- host bridge ---------------------------------------------------------
  function send(message) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      console.warn('[webdesktopmcp] __TAURI_INTERNALS__.invoke unavailable; message dropped.');
      return;
    }
    try {
      // Fire-and-forget: the host replies over the bridge (eval), not this promise.
      void internals.invoke(IPC_COMMAND, { message: message });
    } catch (err) {
      console.warn('[webdesktopmcp] IPC send failed:', err);
    }
  }

  var host = {
    send: send,
    onMessage: function (handler) {
      subscribers.push(handler);
      return function () {
        var i = subscribers.indexOf(handler);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }
  };
  // Called by the native host via eval; not part of the public bridge API.
  host._deliver = function (message) {
    subscribers.slice().forEach(function (handler) {
      try {
        handler(message);
      } catch (err) {
        console.error('[webdesktopmcp] subscriber failed:', err);
      }
    });
  };
  window.__webDesktopMcpHost = host;

  // ---- shared helpers ------------------------------------------------------
  function domError(name, message) {
    if (typeof DOMException === 'function') return new DOMException(message, name);
    var e = new Error(message);
    e.name = name;
    return e;
  }
  function abortError() {
    return domError('AbortError', 'The operation was aborted.');
  }
  function genId(prefix) {
    var g = globalThis.crypto;
    if (g && g.randomUUID) return prefix + '-' + g.randomUUID();
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function errorCodeOf(err) {
    return err && err.name === 'AbortError' ? 'AbortError' : 'ExecutionError';
  }

  // ---- case 1: native WebMCP — mirror registrations to the host ------------
  if ('modelContext' in document) {
    var native = document.modelContext;
    if (native && typeof native.registerTool === 'function') {
      var mirrored = new Map(); // name -> execute callback
      var inFlight = new Map(); // invocationId -> AbortController
      var originalRegister = native.registerTool.bind(native);
      native.registerTool = function (tool, options) {
        try {
          if (tool && typeof tool.name === 'string') {
            mirrored.set(tool.name, tool.execute);
            send({
              kind: 'register',
              invocationId: 'mirror-' + tool.name + '-' + Date.now(),
              tool: {
                name: tool.name,
                title: typeof tool.title === 'string' ? tool.title : undefined,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations
              },
              exposedTo: options && Array.isArray(options.exposedTo) ? options.exposedTo.map(String) : undefined
            });
          }
        } catch (err) {
          console.warn('[webdesktopmcp] mirror failed:', err);
        }
        return originalRegister(tool, options);
      };
      // Keep the wrapper invisible to feature checks.
      try {
        Object.defineProperty(native.registerTool, 'name', { value: 'registerTool', configurable: true });
      } catch (e) { /* non-fatal */ }
      host.onMessage(function (msg) {
        if (msg.kind === 'execute') {
          var execute = mirrored.get(msg.name);
          if (typeof execute !== 'function') {
            send({
              kind: 'executeResult', invocationId: msg.invocationId, ok: false,
              errorCode: 'NotFoundError',
              errorMessage: 'Tool "' + msg.name + '" is not registered in this frame.'
            });
            return;
          }
          var controller = new AbortController();
          inFlight.set(msg.invocationId, controller);
          Promise.resolve()
            .then(function () {
              return execute(isPlainObject(msg.input) ? msg.input : {}, { signal: controller.signal });
            })
            .then(function (result) {
              var serialised;
              try {
                serialised = JSON.stringify(result === undefined ? null : result);
              } catch (e) {
                throw new Error('Tool result is not JSON-serialisable.');
              }
              send({ kind: 'executeResult', invocationId: msg.invocationId, ok: true, result: serialised });
            }, function (err) {
              send({
                kind: 'executeResult', invocationId: msg.invocationId, ok: false,
                errorCode: errorCodeOf(err), errorMessage: errorMessage(err)
              });
            })
            .finally(function () { inFlight.delete(msg.invocationId); });
        } else if (msg.kind === 'abort') {
          var controller = inFlight.get(msg.invocationId);
          if (controller) controller.abort();
        }
        // NOTE: native unregister (AbortSignal abort) is not mirrored back —
        // mirrored tools stay host-visible until the webview is destroyed.
      });
    }
    return;
  }

  // ---- case 2: polyfill document.modelContext ------------------------------
  var localTools = new Map();      // name -> declaration (with .execute)
  var remoteTools = [];            // other frames' tools, as last reported
  var disposed = false;

  function validateTool(tool) {
    if (!isPlainObject(tool)) throw domError('InvalidStateError', 'Tool must be an object.');
    if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
      throw domError('InvalidStateError', 'Invalid tool name: must be 1-128 characters of [A-Za-z0-9_.-].');
    }
    if (typeof tool.description !== 'string' || tool.description.length === 0) {
      throw domError('InvalidStateError', 'Tool "' + tool.name + '": description is required and must be a non-empty string.');
    }
    if (typeof tool.execute !== 'function') {
      throw domError('InvalidStateError', 'Tool "' + tool.name + '": execute must be a function.');
    }
    if (tool.inputSchema !== undefined && (!isPlainObject(tool.inputSchema) || typeof tool.inputSchema.type !== 'string')) {
      throw domError('InvalidStateError', 'Tool "' + tool.name + '": inputSchema must be a JSON Schema object with a string "type".');
    }
  }
  function publicTool(info) {
    return {
      name: info.name, title: info.title, description: info.description,
      inputSchema: info.inputSchema, annotations: info.annotations,
      origin: info.origin, frameId: info.frameId
    };
  }

  class ModelContext extends EventTarget {
    constructor() {
      super();
      var self = this;
      var registerPending = new Map(); // invocationId -> { toolName, resolve, reject }
      var getToolsPending = new Map(); // requestId -> { resolve, reject }
      var forwardPending = new Map();  // requestId -> { resolve, reject }
      var invocations = new Map();     // invocationId -> AbortController
      var onToolChangeHandler = null;
      Object.defineProperty(this, 'ontoolchange', {
        enumerable: true,
        get: function () { return onToolChangeHandler || null; },
        set: function (handler) {
          if (onToolChangeHandler) self.removeEventListener('toolchange', onToolChangeHandler);
          onToolChangeHandler = typeof handler === 'function' ? handler : null;
          if (onToolChangeHandler) self.addEventListener('toolchange', onToolChangeHandler);
        }
      });
      Object.defineProperty(this, 'remoteTools', {
        get: function () { return remoteTools.slice(); }
      });
      function forget(name) {
        if (localTools.delete(name)) self.dispatchEvent(new Event('toolchange'));
      }

      this.registerTool = function (tool, options) {
        if (disposed) return Promise.reject(domError('InvalidStateError', 'The model context has been disposed.'));
        try { validateTool(tool); } catch (err) { return Promise.reject(err); }
        if (localTools.has(tool.name)) {
          return Promise.reject(domError('InvalidStateError', 'A tool named "' + tool.name + '" is already registered in this document.'));
        }
        var exposedTo = options && Array.isArray(options.exposedTo) ? options.exposedTo.map(String) : undefined;
        var invocationId = genId('reg');
        var settled = false;
        var promise = new Promise(function (resolve, reject) {
          registerPending.set(invocationId, {
            toolName: tool.name,
            resolve: function () { settled = true; resolve(undefined); },
            reject: function (reason) { settled = true; reject(reason); }
          });
        });
        if (options && options.signal) {
          var signal = options.signal;
          if (signal.aborted) { registerPending.delete(invocationId); return Promise.reject(abortError()); }
          // Not removed on settlement: the signal owns the tool's lifetime.
          signal.addEventListener('abort', function () {
            if (!settled) {
              var pending = registerPending.get(invocationId);
              if (pending) { registerPending.delete(invocationId); pending.reject(abortError()); }
              forget(tool.name);
            } else if (localTools.has(tool.name)) {
              forget(tool.name);
              send({ kind: 'unregister', invocationId: genId('unreg'), name: tool.name });
            }
          }, { once: true });
        }
        localTools.set(tool.name, tool);
        self.dispatchEvent(new Event('toolchange'));
        send({
          kind: 'register', invocationId: invocationId,
          tool: {
            name: tool.name, title: tool.title, description: tool.description,
            inputSchema: tool.inputSchema, annotations: tool.annotations
          },
          exposedTo: exposedTo
        });
        return promise;
      };

      this.unregisterTool = function (name) {
        if (disposed) return Promise.reject(domError('InvalidStateError', 'The model context has been disposed.'));
        if (!localTools.has(name)) {
          return Promise.reject(domError('NotFoundError', 'No tool named "' + name + '" is registered in this document.'));
        }
        forget(name);
        send({ kind: 'unregister', invocationId: genId('unreg'), name: name });
        return Promise.resolve();
      };

      this.getTools = function (options) {
        if (disposed) return Promise.reject(domError('InvalidStateError', 'The model context has been disposed.'));
        var requestId = genId('gt');
        var promise = new Promise(function (resolve, reject) {
          getToolsPending.set(requestId, { resolve: resolve, reject: reject });
          if (options && options.signal && options.signal.aborted) {
            getToolsPending.delete(requestId);
            reject(abortError());
          }
        });
        send({
          kind: 'getToolsRequest', requestId: requestId,
          fromOrigins: options && Array.isArray(options.fromOrigins) ? options.fromOrigins.map(String) : undefined,
          forOrigin: typeof location !== 'undefined' ? String(location.origin) : 'null'
        });
        return promise;
      };

      this.executeTool = function (tool, inputObject, options) {
        if (disposed) return Promise.reject(domError('InvalidStateError', 'The model context has been disposed.'));
        var requestId = genId('ex');
        var promise = new Promise(function (resolve, reject) {
          forwardPending.set(requestId, { resolve: resolve, reject: reject });
          if (options && options.signal && options.signal.aborted) {
            forwardPending.delete(requestId);
            reject(abortError());
          }
        });
        send({
          kind: 'executeForward', requestId: requestId,
          name: tool && tool.name ? String(tool.name) : '',
          input: inputObject === undefined || inputObject === null ? {} : inputObject,
          fromOrigin: typeof location !== 'undefined' ? String(location.origin) : 'null'
        });
        return promise;
      };

      host.onMessage(function (msg) {
        if (disposed) return;
        if (msg.kind === 'registerResult') {
          var pending = registerPending.get(msg.invocationId);
          if (!pending) return;
          registerPending.delete(msg.invocationId);
          if (msg.ok) {
            if (!localTools.has(pending.toolName)) {
              // Aborted while in flight: roll the host back too.
              send({ kind: 'unregister', invocationId: genId('unreg'), name: pending.toolName });
            }
            pending.resolve(undefined);
          } else {
            forget(pending.toolName);
            pending.reject(domError('InvalidStateError', String(msg.errorMessage || 'Registration rejected.')));
          }
        } else if (msg.kind === 'getToolsResponse') {
          var gp = getToolsPending.get(msg.requestId);
          if (!gp) return;
          getToolsPending.delete(msg.requestId);
          gp.resolve((msg.tools || []).map(publicTool));
        } else if (msg.kind === 'executeForwardResult') {
          var fp = forwardPending.get(msg.requestId);
          if (!fp) return;
          forwardPending.delete(msg.requestId);
          if (msg.ok) fp.resolve(String(msg.result == null ? 'null' : msg.result));
          else fp.reject(domError(String(msg.errorCode || 'ExecutionError'), String(msg.errorMessage || '')));
        } else if (msg.kind === 'execute') {
          handleHostExecute(msg.invocationId, msg.name, msg.input);
        } else if (msg.kind === 'abort') {
          var controller = invocations.get(msg.invocationId);
          if (controller) controller.abort();
        } else if (msg.kind === 'toolsChanged') {
          remoteTools = msg.tools || [];
          self.dispatchEvent(new Event('toolchange'));
        }
      });

      function handleHostExecute(invocationId, name, input) {
        var declaration = localTools.get(name);
        if (!declaration || disposed) {
          send({
            kind: 'executeResult', invocationId: invocationId, ok: false,
            errorCode: 'NotFoundError',
            errorMessage: 'Tool "' + name + '" is not registered in this frame.'
          });
          return;
        }
        var controller = new AbortController();
        invocations.set(invocationId, controller);
        Promise.resolve()
          .then(function () {
            return declaration.execute(isPlainObject(input) ? input : {}, { signal: controller.signal });
          })
          .then(function (result) {
            var serialised;
            try {
              serialised = JSON.stringify(result === undefined ? null : result);
            } catch (e) {
              throw new Error('Tool result is not JSON-serialisable.');
            }
            send({ kind: 'executeResult', invocationId: invocationId, ok: true, result: serialised });
          }, function (err) {
            send({
              kind: 'executeResult', invocationId: invocationId, ok: false,
              errorCode: errorCodeOf(err), errorMessage: errorMessage(err)
            });
          })
          .finally(function () { invocations.delete(invocationId); });
      }
    }
  }

  var modelContext = new ModelContext();
  Object.defineProperty(document, 'modelContext', {
    value: modelContext, enumerable: true, configurable: true, writable: false
  });
})();
