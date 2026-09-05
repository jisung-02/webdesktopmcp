import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installModelContextPolyfill, type InstalledPolyfill } from "../src/index.js";
import type { HostMessage } from "@webdesktopmcp/protocol";

class MockHost {
  sent: Record<string, unknown>[] = [];
  #handlers = new Set<(m: unknown) => void>();

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  onMessage(handler: (m: unknown) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  deliver(message: HostMessage): void {
    for (const h of [...this.#handlers]) h(message);
  }

  last(kind: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.kind === kind);
  }
}

let host: MockHost;
let installed: InstalledPolyfill | null;

function install(opts: { force?: boolean; declarative?: boolean } = {}) {
  host = new MockHost();
  installed = installModelContextPolyfill({
    bridge: host,
    frameId: "main",
    appName: "TestApp",
    appVersion: "1.0.0",
    force: true,
    ...opts,
  });
  return installed!;
}

function ackRegister(invocationId: string, ok = true, errorMessage?: string) {
  host.deliver({
    kind: "registerResult",
    invocationId,
    ok,
    ...(ok ? {} : { errorMessage }),
  } as HostMessage);
}

beforeEach(() => {
  document.body.innerHTML = "";
  // happy-dom does not guarantee a secure-context flag; polyfill is force-installed.
});

afterEach(() => {
  installed?.dispose();
  installed = null;
});

const makeTool = (name = "greet", execute = vi.fn(async () => ({ ok: true }))) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object", properties: {} },
  execute,
});

describe("installation", () => {
  it("installs document.modelContext", () => {
    install();
    expect(document.modelContext).toBeDefined();
    expect(typeof document.modelContext.registerTool).toBe("function");
  });

  it("does not overwrite a native implementation unless forced", () => {
    const native = { registerTool: () => {} };
    Object.defineProperty(document, "modelContext", { value: native, configurable: true });
    const result = installModelContextPolyfill({
      bridge: new MockHost(),
      frameId: "main",
      appName: "A",
      appVersion: "1",
    });
    expect(result).toBeNull();
    expect(document.modelContext).toBe(native);
    delete (document as unknown as Record<string, unknown>).modelContext;
  });
});

describe("registerTool", () => {
  it("sends a register message and resolves on host ack", async () => {
    install();
    const p = document.modelContext.registerTool(makeTool());
    const msg = host.last("register");
    expect(msg).toMatchObject({ kind: "register" });
    expect((msg!.tool as { name: string }).name).toBe("greet");
    ackRegister(msg!.invocationId as string);
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects duplicate names locally without messaging the host", async () => {
    install();
    const first = document.modelContext.registerTool(makeTool("dup"));
    ackRegister(host.last("register")!.invocationId as string);
    await first;
    const sentBefore = host.sent.length;
    await expect(document.modelContext.registerTool(makeTool("dup"))).rejects.toThrow(
      /already registered/,
    );
    expect(host.sent.length).toBe(sentBefore);
  });

  it("rejects invalid declarations synchronously", async () => {
    install();
    await expect(
      document.modelContext.registerTool(makeTool("bad name!")),
    ).rejects.toThrow(/Invalid tool name/);
    await expect(
      document.modelContext.registerTool({ name: "x", description: "", execute: async () => 1 }),
    ).rejects.toThrow(/description/);
  });

  it("rolls back the local entry when the host rejects (cross-frame clash)", async () => {
    install();
    const p = document.modelContext.registerTool(makeTool("clash"));
    const invocationId = host.last("register")!.invocationId as string;
    ackRegister(invocationId, false, 'Name "clash" already registered by another frame.');
    await expect(p).rejects.toThrow(/another frame/);
    // After rollback, re-registration should be possible.
    const retry = document.modelContext.registerTool(makeTool("clash"));
    ackRegister(host.last("register")!.invocationId as string);
    await expect(retry).resolves.toBeUndefined();
  });

  it("unregisters via AbortSignal (spec behaviour)", async () => {
    install();
    const controller = new AbortController();
    const p = document.modelContext.registerTool(makeTool("sig"), { signal: controller.signal });
    ackRegister(host.last("register")!.invocationId as string);
    await p;
    controller.abort();
    expect(host.last("unregister")).toMatchObject({ kind: "unregister", name: "sig" });
    await expect(document.modelContext.unregisterTool("sig")).rejects.toThrow(/No tool/);
  });
});

describe("host-driven execution", () => {
  it("invokes the callback and returns JSON-stringified result", async () => {
    install();
    const execute = vi.fn(async (input: Record<string, unknown>) => ({ echo: input.q }));
    const p = document.modelContext.registerTool(makeTool("echo", execute));
    ackRegister(host.last("register")!.invocationId as string);
    await p;

    host.deliver({ kind: "execute", invocationId: "inv-1", name: "echo", input: { q: "hi" } });
    await vi.waitFor(() => {
      expect(host.last("executeResult")).toMatchObject({
        kind: "executeResult",
        invocationId: "inv-1",
        ok: true,
        result: '{"echo":"hi"}',
      });
    });
    expect(execute).toHaveBeenCalledWith({ q: "hi" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reports execution errors", async () => {
    install();
    const p = document.modelContext.registerTool(
      makeTool("boom", async () => {
        throw new Error("kaboom");
      }),
    );
    ackRegister(host.last("register")!.invocationId as string);
    await p;

    host.deliver({ kind: "execute", invocationId: "inv-2", name: "boom", input: {} });
    await vi.waitFor(() => {
      expect(host.last("executeResult")).toMatchObject({
        ok: false,
        errorCode: "ExecutionError",
        errorMessage: "kaboom",
      });
    });
  });

  it("propagates host aborts to the callback signal", async () => {
    install();
    let observed: AbortSignal | undefined;
    const p = document.modelContext.registerTool(
      makeTool("slow", async (_input, { signal }) => {
        observed = signal;
        await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }),
    );
    ackRegister(host.last("register")!.invocationId as string);
    await p;

    host.deliver({ kind: "execute", invocationId: "inv-3", name: "slow", input: {} });
    await vi.waitFor(() => expect(observed).toBeDefined());
    host.deliver({ kind: "abort", invocationId: "inv-3" });
    await vi.waitFor(() => {
      expect(host.last("executeResult")).toMatchObject({ ok: false, errorCode: "AbortError" });
    });
  });
});

describe("getTools / executeTool (in-page agent surface)", () => {
  it("fetches cross-frame tools through the host", async () => {
    install();
    const p = document.modelContext.getTools({ fromOrigins: ["https://a.example"] });
    const req = host.last("getToolsRequest");
    expect(req).toMatchObject({ kind: "getToolsRequest", fromOrigins: ["https://a.example"] });
    host.deliver({
      kind: "getToolsResponse",
      requestId: req!.requestId,
      tools: [
        {
          name: "other",
          description: "From another frame",
          origin: "https://a.example",
          frameId: "sidebar",
        },
      ],
    } as HostMessage);
    const tools = await p;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "other", frameId: "sidebar" });
  });

  it("forwards executeTool calls through the host", async () => {
    install();
    const p = document.modelContext.executeTool({ name: "remote" }, { x: 1 });
    const fwd = host.last("executeForward");
    expect(fwd).toMatchObject({ kind: "executeForward", name: "remote", input: { x: 1 } });
    host.deliver({
      kind: "executeForwardResult",
      requestId: fwd!.requestId,
      ok: true,
      result: '"done"',
    } as HostMessage);
    await expect(p).resolves.toBe('"done"');
  });
});

describe("declarative forms", () => {
  it("registers form[toolname] as tools with inferred schemas", async () => {
    install();
    document.body.innerHTML = `
      <form toolname="search-cars" tooldescription="Perform a car make/model search" toolautosubmit>
        <input type="text" name="make" toolparamdescription="The vehicle's make" required>
        <select name="color"><option value="">--</option><option value="red">Red</option></select>
        <button type="submit">Search</button>
      </form>`;
    await vi.waitFor(() => {
      expect(host.last("register")).toMatchObject({ kind: "register" });
    });
    const tool = host.last("register")!.tool as { inputSchema: Record<string, unknown> };
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        make: { type: "string", description: "The vehicle's make" },
        color: { type: "string", enum: ["red"] },
      },
      required: ["make"],
    });
  });

  it("fills fields and captures respondWith() on agent submit", async () => {
    install();
    document.body.innerHTML = `
      <form id="f" toolname="order-pizza" tooldescription="Order a pizza" toolautosubmit>
        <input type="text" name="flavour" toolparamdescription="Pizza flavour" required>
        <button type="submit">Order</button>
      </form>`;
    const form = document.getElementById("f") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      (e as SubmitEvent & { respondWith(p: unknown): void }).respondWith({
        orderId: 42,
      });
    });

    await vi.waitFor(() => expect(host.last("register")).toBeDefined());
    // Execute through the host path.
    const reg = host.last("register")!;
    host.deliver({ kind: "execute", invocationId: "inv-9", name: "order-pizza", input: { flavour: "tuna" } });
    await vi.waitFor(() => {
      expect(host.last("executeResult")).toMatchObject({ ok: true });
    });
    expect(form.querySelector<HTMLInputElement>("input[name=flavour]")!.value).toBe("tuna");
    const result = JSON.parse((host.last("executeResult")!.result as string) ?? "{}");
    expect(result).toEqual({ orderId: 42 });
  });

  it("unregisters when the toolname attribute is removed", async () => {
    install();
    document.body.innerHTML = `
      <form toolname="temp-tool" tooldescription="Temporary"><input name="a"></form>`;
    await vi.waitFor(() => expect(host.last("register")).toBeDefined());
    const form = document.querySelector("form[toolname]") as HTMLFormElement;
    form.removeAttribute("toolname");
    await vi.waitFor(() => expect(host.last("unregister")).toMatchObject({ name: "temp-tool" }));
  });
});


describe("registration and invocation lifetime regressions", () => {
  it("rolls back an in-flight registration when its signal aborts", async () => {
    install();
    const controller = new AbortController();
    const p = document.modelContext.registerTool(makeTool("pending"), { signal: controller.signal });
    const reg = host.last("register")!;
    const rejected = expect(p).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(host.last("unregister")).toMatchObject({ name: "pending" });
    ackRegister(reg.invocationId as string);
    expect(installed!.registeredToolNames).not.toContain("pending");
  });

  it("does not send requests for pre-aborted operations", async () => {
    install();
    const controller = new AbortController();
    controller.abort();
    await expect(document.modelContext.executeTool({ name: "write" }, {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(document.modelContext.getTools({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(document.modelContext.registerTool(makeTool(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(host.sent).toHaveLength(0);
  });

  it("cancels a forwarded execution at the host", async () => {
    install();
    const controller = new AbortController();
    const p = document.modelContext.executeTool({ name: "write" }, {}, { signal: controller.signal });
    const request = host.last("executeForward")!;
    const rejected = expect(p).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(host.last("cancelForward")).toMatchObject({ requestId: request.requestId });
  });

  it("does not let an old registration signal remove its replacement", async () => {
    install();
    const old = new AbortController();
    const first = document.modelContext.registerTool(makeTool("reused"), { signal: old.signal });
    ackRegister(host.last("register")!.invocationId as string);
    await first;
    await document.modelContext.unregisterTool("reused");
    const next = document.modelContext.registerTool(makeTool("reused"));
    ackRegister(host.last("register")!.invocationId as string);
    await next;
    old.abort();
    expect(installed!.registeredToolNames).toContain("reused");
  });

  it("unregisters owned tools and cancels pending forwarded calls on dispose", async () => {
    install();
    const reg = document.modelContext.registerTool(makeTool());
    ackRegister(host.last("register")!.invocationId as string);
    await reg;
    const p = document.modelContext.executeTool({ name: "remote" });
    const rejected = expect(p).rejects.toMatchObject({ name: "AbortError" });
    installed!.dispose();
    installed = null;
    await rejected;
    expect(host.last("unregister")).toMatchObject({ name: "greet" });
    expect(host.last("cancelForward")).toBeDefined();
  });
});


it("unregisters an in-flight declaration without a late rejection removing its replacement", async () => {
  install();
  const first = document.modelContext.registerTool(makeTool("rapid"));
  const firstId = host.last("register")!.invocationId as string;
  const firstOutcome = first.catch(error => error);
  await document.modelContext.unregisterTool("rapid");
  const second = document.modelContext.registerTool(makeTool("rapid"));
  const secondId = host.last("register")!.invocationId as string;
  ackRegister(firstId, false, "old registration rejected");
  ackRegister(secondId);
  await second;
  expect(installed!.registeredToolNames).toContain("rapid");
  expect(await firstOutcome).toMatchObject({ name: "AbortError" });
});
