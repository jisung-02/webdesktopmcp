import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapWebDesktopMcp,
  installNativeModelContextMirror,
} from "../src/index.js";
import type { HostMessage } from "@webdesktopmcp/protocol";

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
  deliver(m: HostMessage) {
    for (const h of [...this.#handlers]) h(m);
  }
}

let cleanup: { dispose(): void } | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  delete (document as unknown as Record<string, unknown>).modelContext;
  cleanup = null;
});

afterEach(() => {
  cleanup?.dispose();
  delete (document as unknown as Record<string, unknown>).modelContext;
});

describe("bootstrap mode selection", () => {
  it("installs the polyfill when no native context exists", () => {
    const handle = bootstrapWebDesktopMcp({
      bridge: new MockHost(),
      frameId: "main",
      appName: "A",
      appVersion: "1",
      force: true,
    })!;
    expect(handle.mode).toBe("polyfill");
    expect("modelContext" in document).toBe(true);
    handle.dispose();
    expect("modelContext" in document).toBe(false);
  });

  it("uses the native mirror when a native context exists (auto)", async () => {
    const registerMock = vi.fn(async (_tool: unknown) => undefined);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool: registerMock },
    });

    const handle = bootstrapWebDesktopMcp({
      bridge: new MockHost(),
      frameId: "main",
      appName: "A",
      appVersion: "1",
    })!;
    expect(handle.mode).toBe("native-mirror");

    // Page registers through the (wrapped) native API.
    await (document as unknown as { modelContext: { registerTool: (t: unknown) => Promise<undefined> } })
      .modelContext
      .registerTool({ name: "nat-tool", description: "Native tool", execute: async () => 1 });

    handle.dispose();
    // Native received the registration through the transparent wrapper...
    expect(registerMock).toHaveBeenCalledTimes(1);
    // ...and after dispose the original function object is restored.
    expect(document.modelContext.registerTool).toBe(registerMock);
  });

  it("require-native fails loudly when native support is absent", () => {
    const handle = bootstrapWebDesktopMcp({
      bridge: new MockHost(),
      frameId: "main",
      appName: "A",
      appVersion: "1",
      native: "require-native",
    });
    expect(handle).toBeNull();
    expect("modelContext" in document).toBe(false);
  });
});

describe("native mirror dispatch", () => {
  it("routes external invocations into the captured native execute", async () => {
    const host = new MockHost();
    const execute = vi.fn(async (input: { q?: string }) => ({ echoed: input.q ?? null }));
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: async (tool: unknown) => {
          // Real native would store the tool; the mirror wraps before us so
          // this receives the original declaration.
          void tool;
          return undefined;
        },
      },
    });
    const mirror = installNativeModelContextMirror(host, () => {});
    await (document as unknown as { modelContext: { registerTool: (t: unknown) => Promise<undefined> } })
      .modelContext
      .registerTool({ name: "t1", description: "d", execute });

    const executeMsg = host.sent.find((m) => m.kind === "execute") as
      | { invocationId: string }
      | undefined;
    void executeMsg;
    host.deliver({ kind: "execute", invocationId: "x1", name: "t1", input: { q: "hi" } });
    await vi.waitFor(() => {
      const result = host.sent.find(
        (m) => m.kind === "executeResult" && m.invocationId === "x1",
      ) as { ok: boolean; result?: string } | undefined;
      expect(result?.ok).toBe(true);
      expect(JSON.parse(result!.result!)).toEqual({ echoed: "hi" });
    });
    expect(execute).toHaveBeenCalledWith({ q: "hi" }, expect.anything());

    mirror.dispose();
  });
});
