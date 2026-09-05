import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installModelContextPolyfill, defineTool } from "@webdesktopmcp/core";
import type { InstalledPolyfill } from "@webdesktopmcp/core";
import { useMcpTool } from "../src/use-mcp-tool.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockHost {
  sent: Record<string, unknown>[] = [];
  #handlers = new Set<(m: unknown) => void>();
  send(m: Record<string, unknown>) {
    this.sent.push(m);
  }
  onMessage(h: (m: unknown) => void) {
    this.#handlers.add(h);
    return () => this.#handlers.delete(h);
  }
  deliver(m: unknown) {
    for (const h of [...this.#handlers]) h(m);
  }
}

let host: MockHost;
let polyfill: InstalledPolyfill | null;
let container: HTMLElement;
let root: Root | undefined;

beforeEach(() => {
  document.body.innerHTML = "";
  delete (document as unknown as Record<string, unknown>).modelContext;
  host = new MockHost();
  polyfill = installModelContextPolyfill({
    bridge: host,
    frameId: "main",
    appName: "T",
    appVersion: "1",
    force: true,
    declarative: false,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  polyfill?.dispose();
  polyfill = null;
});

function render(component: ReturnType<typeof createElement>): void {
  if (!root) {
    root = createRoot(container);
  }
  act(() => {
    root!.render(component);
  });
}

const notesTool = (notes: string[]) =>
  defineTool<{ keyword: string }>({
    name: "search-notes",
    description: "키워드로 메모를 검색한다",
    inputSchema: {
      type: "object",
      properties: { keyword: { type: "string", description: "검색 키워드" } },
      required: ["keyword"],
    },
    execute: async ({ keyword }) => notes.filter((n) => n.includes(keyword)),
  });

function NotesApp({
  notes,
  onStatus,
}: {
  notes: string[];
  onStatus?: (s: { registered: boolean; error?: string }) => void;
}) {
  const status = useMcpTool(notesTool(notes));
  onStatus?.(status);
  return null;
}

describe("useMcpTool", () => {
  it("uses only the registration signal with a native-shaped API across remounts", async () => {
    polyfill?.dispose();
    polyfill = null;
    const registered = new Set<string>();
    const signals: AbortSignal[] = [];
    // The draft API has no unregisterTool extension.
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        async registerTool(tool: { name: string }, options: { signal: AbortSignal }) {
          if (registered.has(tool.name)) throw new Error("Duplicate tool");
          registered.add(tool.name);
          signals.push(options.signal);
          options.signal.addEventListener("abort", () => registered.delete(tool.name), { once: true });
        },
      },
    });
    for (let mount = 0; mount < 2; mount++) {
      await act(async () => render(createElement(NotesApp, { notes: ["a"] })));
      expect(registered.has("search-notes")).toBe(true);
      act(() => root!.unmount());
      root = undefined;
      expect(signals[mount].aborted).toBe(true);
      expect(registered.size).toBe(0);
    }
  });

  it("registers on mount through document.modelContext", () => {
    render(createElement(NotesApp, { notes: ["a"] }));
    const register = host.sent.find((m) => m.kind === "register") as
      | { tool?: { name: string; description: string; inputSchema?: { required?: string[] } } }
      | undefined;
    expect(register?.tool?.name).toBe("search-notes");
    expect(register?.tool?.description).toBe("키워드로 메모를 검색한다");
    expect(register?.tool?.inputSchema?.required).toEqual(["keyword"]);
  });

  it("execute always sees the latest render's state (no stale closure)", async () => {
    render(createElement(NotesApp, { notes: ["회의 메모", "장보기"] }));
    render(createElement(NotesApp, { notes: ["회의 메모", "회의록 초안"] })); // state changed after mount

    // Invoke through the host path.
    const register = host.sent.find((m) => m.kind === "register") as { invocationId?: string };
    host.deliver({
      kind: "execute",
      invocationId: register!.invocationId!,
      name: "search-notes",
      input: { keyword: "회의" },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const result = host.sent.find((m) => m.kind === "executeResult") as { ok: boolean; result?: string };
    expect(result.ok).toBe(true);
    // The ORIGINAL notes array would have returned ["회의 메모"] only —
    // the latest closure returns both.
    expect(JSON.parse(result.result!)).toEqual(["회의 메모", "회의록 초안"]);
  });

  it("unregisters on unmount", () => {
    render(createElement(NotesApp, { notes: ["a"] }));
    const sentBefore = host.sent.length;
    act(() => {
      root!.unmount();
    });
    root = undefined;
    expect(host.sent.slice(sentBefore).some((m) => m.kind === "unregister")).toBe(true);
  });

  it("reports registered:true through React state once registration settles", async () => {
    const statuses: { registered: boolean; error?: string }[] = [];
    render(
      createElement(NotesApp, {
        notes: ["a"],
        onStatus: (s) => statuses.push(s),
      }),
    );
    // The host acknowledges the registration; the polyfill promise resolves
    // and the hook's state update re-renders the component.
    const register = host.sent.find((m) => m.kind === "register") as { invocationId?: string };
    await act(async () => {
      host.deliver({ kind: "registerResult", invocationId: register!.invocationId, ok: true });
      await new Promise((r) => setTimeout(r, 5));
    });
    render(
      createElement(NotesApp, {
        notes: ["a"],
        onStatus: (s) => statuses.push(s),
      }),
    );
    expect(statuses.at(-1)).toMatchObject({ registered: true });
  });

  it("reports an error status when document.modelContext is missing", () => {
    polyfill?.dispose();
    polyfill = null;
    const statuses: { registered: boolean; error?: string }[] = [];
    expect(() =>
      render(
        createElement(NotesApp, {
          notes: [],
          onStatus: (s) => statuses.push(s),
        }),
      ),
    ).not.toThrow();
    expect(host.sent).toHaveLength(0);
    expect(statuses.at(-1)?.registered).toBe(false);
    expect(statuses.at(-1)?.error).toMatch(/modelContext is unavailable/);
  });
});
