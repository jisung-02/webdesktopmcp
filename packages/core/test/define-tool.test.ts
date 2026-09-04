import { describe, expect, it, vi } from "vitest";
import { defineTool } from "../src/define-tool.js";

describe("defineTool", () => {
  it("passes the declaration through unchanged (zero runtime overhead)", () => {
    const execute = vi.fn(async ({ q }: { q: string }) => q.toUpperCase());
    const tool = defineTool<{ q: string }>({
      name: "shout",
      description: "대문자로 만든다",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", description: "입력" } },
        required: ["q"],
      },
      annotations: { readOnlyHint: true },
      execute,
    });

    // Shape required by document.modelContext.registerTool
    expect(tool.name).toBe("shout");
    expect(tool.description).toBe("대문자로 만든다");
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(typeof tool.execute).toBe("function");

    return tool.execute({ q: "hi" }, { signal: new AbortController().signal }).then((r) => {
      expect(r).toBe("HI");
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it("defaults the input type to Record<string, unknown>", async () => {
    const tool = defineTool({
      name: "ping",
      description: "returns pong",
      execute: async () => "pong",
    });
    await expect(tool.execute({}, { signal: new AbortController().signal })).resolves.toBe("pong");
  });
});
