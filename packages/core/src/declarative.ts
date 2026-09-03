/**
 * Declarative WebMCP API — turns `<form toolname="..." tooldescription="...">`
 * elements into agent-invocable tools, per the W3C declarative-API explainer.
 *
 * Polyfill deviations from the (still unsettled) draft:
 *  - Schema "compilation" from form controls is our own deterministic subset
 *    (the spec algorithm is TODO; Chromium prototypes a loose version).
 *  - `:tool-form-active` cannot be polyfilled; we set `data-webmcp-active`
 *    on the form instead.
 *  - `SubmitEvent#respondWith()` and `agentInvoked` are polyfilled on
 *    `SubmitEvent.prototype` when missing.
 */

import type { JsonSchemaObject } from "@webdesktopmcp/protocol";
import type { ModelContext } from "./polyfill.js";
import type { PolyfillInstallOptions } from "./types.js";

type Log = NonNullable<PolyfillInstallOptions["log"]>;

const RESPOND_WITH_PROMISES = new WeakMap<object, Promise<unknown>>();
let agentInvoked = false;

function isAgentInvoked(): boolean {
  return agentInvoked;
}

/** Patch SubmitEvent with the draft's `respondWith()` / `agentInvoked`. */
function patchSubmitEvent(): void {
  const SEP = (globalThis as unknown as { SubmitEvent?: { prototype: Record<string, unknown> } }).SubmitEvent;
  if (!SEP) return;
  const proto = SEP.prototype;
  if (typeof proto.respondWith !== "function") {
    Object.defineProperty(proto, "respondWith", {
      value(this: object, p: Promise<unknown>) {
        RESPOND_WITH_PROMISES.set(this, Promise.resolve(p));
      },
      writable: true,
      configurable: true,
    });
  }
  if (!("agentInvoked" in proto)) {
    Object.defineProperty(proto, "agentInvoked", {
      get() {
        return isAgentInvoked();
      },
      configurable: true,
    });
  }
}

interface CompiledFormTool {
  form: HTMLFormElement;
  name: string;
  execute(input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown>;
}

function inferSchema(form: HTMLFormElement): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    "input[name], select[name], textarea[name]",
  );
  for (const control of controls) {
    const name = control.getAttribute("name");
    if (!name) continue;
    const typeAttr = (control as HTMLInputElement).type ?? "text";
    if (typeAttr === "submit" || typeAttr === "button" || typeAttr === "file" || typeAttr === "image") {
      continue;
    }
    let property: Record<string, unknown>;
    if (typeAttr === "number" || typeAttr === "range") {
      property = { type: "number" };
    } else if (typeAttr === "checkbox") {
      property = { type: "boolean" };
    } else if (control instanceof HTMLSelectElement) {
      const options = [...control.options].map((o) => o.value).filter((v) => v !== "");
      property = options.length > 0 ? { type: "string", enum: options } : { type: "string" };
    } else {
      property = { type: "string" };
    }
    const paramDescription = control.getAttribute("toolparamdescription");
    if (paramDescription) property.description = paramDescription;
    if (control.hasAttribute("required")) required.push(name);
    properties[name] = property;
  }
  const schema: JsonSchemaObject = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function setControlValue(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: unknown,
): void {
  const typeAttr = (control as HTMLInputElement).type;
  if (typeAttr === "checkbox") {
    (control as HTMLInputElement).checked = Boolean(value);
  } else if (typeAttr === "radio") {
    if ((control as HTMLInputElement).value === String(value)) {
      (control as HTMLInputElement).checked = true;
    }
  } else {
    control.value = value === null || value === undefined ? "" : String(value);
  }
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function compileFormTool(form: HTMLFormElement, log: Log): CompiledFormTool | null {
  const name = form.getAttribute("toolname");
  if (!name) return null;
  const description = form.getAttribute("tooldescription") ?? "";
  if (!description) {
    log("warn", `[webdesktopmcp] <form toolname="${name}"> has no tooldescription — skipped.`);
    return null;
  }

  const inputSchema = inferSchema(form);

  const execute = async (
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<unknown> => {
    // Fill declared controls from the agent input.
    for (const [key, value] of Object.entries(input ?? {})) {
      const named = form.elements.namedItem(key);
      if (!named || named instanceof RadioNodeList) continue;
      setControlValue(named as HTMLInputElement, value);
    }

    const autoSubmit = form.hasAttribute("toolautosubmit");
    form.setAttribute("data-webmcp-active", "");
    agentInvoked = true;
    try {
      if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!autoSubmit) {
        // Spec behaviour: without toolautosubmit the agent fills and defers to
        // the user — surface the submit button.
        const submit = form.querySelector<HTMLElement>(
          "button[type=submit], input[type=submit]",
        );
        submit?.focus();
        return { filled: true, submitted: false };
      }

      let captured: SubmitEvent | null = null;
      const onCapturingSubmit = (e: Event) => {
        if (e instanceof SubmitEvent && isAgentInvoked()) captured = e;
      };
      form.addEventListener("submit", onCapturingSubmit, true);
      try {
        const SubmitEventCtor = (globalThis as { SubmitEvent?: typeof SubmitEvent }).SubmitEvent;
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else if (SubmitEventCtor) {
          // Older engines (e.g. some WebKitGTK builds) may lack requestSubmit.
          form.dispatchEvent(new SubmitEventCtor("submit", { bubbles: true, cancelable: true }));
        } else {
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      } finally {
        form.removeEventListener("submit", onCapturingSubmit, true);
      }

      const respondWith = captured ? RESPOND_WITH_PROMISES.get(captured) : undefined;
      if (respondWith) {
        return await raceWithAbort(respondWith, options.signal);
      }
      return { filled: true, submitted: true };
    } finally {
      agentInvoked = false;
      form.removeAttribute("data-webmcp-active");
    }
  };

  return { form, name, execute };
}

function raceWithAbort(p: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(p).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Watch `<form toolname>` mutations and keep declarative tools in sync.
 * Returns a disposer.
 */
export function setupDeclarativeApi(mc: ModelContext, log: Log): () => void {
  patchSubmitEvent();

  const registered = new Map<HTMLFormElement, string>();

  const sync = () => {
    const forms = [...document.querySelectorAll<HTMLFormElement>("form[toolname]")];
    const seen = new Set<HTMLFormElement>();

    for (const form of forms) {
      seen.add(form);
      const previous = registered.get(form);
      const compiled = compileFormTool(form, log);
      if (!compiled) {
        if (previous) void mc.unregisterTool(previous).catch(() => {});
        registered.delete(form);
        continue;
      }
      const changed =
        previous !== compiled.name ||
        form.dataset.webmcpCompiled !== fingerprint(form);
      if (!changed) continue;
      if (previous && previous !== compiled.name) {
        void mc.unregisterTool(previous).catch(() => {});
      }
      // Optimistic: the tool is live app-wide as soon as the host processes
      // the register message; don't wait for the ack to track it.
      registered.set(form, compiled.name);
      form.dataset.webmcpCompiled = fingerprint(form);
      void mc
        .registerTool({
          name: compiled.name,
          description: form.getAttribute("tooldescription") ?? compiled.name,
          inputSchema: inferSchema(form),
          annotations: { readOnlyHint: false },
          execute: compiled.execute,
        })
        .catch((err) => {
          log("warn", `[webdesktopmcp] Declarative tool "${compiled.name}" rejected: ${String(err)}`);
          if (registered.get(form) === compiled.name) registered.delete(form);
          delete form.dataset.webmcpCompiled;
        });
    }

    // Forms whose toolname was removed.
    for (const [form, name] of registered) {
      if (!seen.has(form) || !form.hasAttribute("toolname")) {
        void mc.unregisterTool(name).catch(() => {});
        registered.delete(form);
        delete form.dataset.webmcpCompiled;
      }
    }
  };

  let scheduled = false;
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      sync();
    });
  };

  sync();
  const observer = new MutationObserver(scheduleSync);
  // At document-start `documentElement` can be null (code injected by a
  // preload); observing the Document node itself covers the whole tree.
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["toolname", "tooldescription", "toolparamdescription", "toolautosubmit"],
  });

  return () => {
    observer.disconnect();
    for (const [, name] of registered) void mc.unregisterTool(name).catch(() => {});
    registered.clear();
  };
}

function fingerprint(form: HTMLFormElement): string {
  return `${form.getAttribute("toolname") ?? ""}|${form.getAttribute("tooldescription") ?? ""}|${
    form.hasAttribute("toolautosubmit") ? "a" : ""
  }|${JSON.stringify(inferSchema(form))}`;
}
