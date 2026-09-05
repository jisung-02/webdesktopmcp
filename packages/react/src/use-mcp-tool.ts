/**
 * `useMcpTool` — register a WebMCP tool that follows the component lifecycle.
 *
 * - Registers on mount (through `document.modelContext` — polyfill or native,
 *   whichever the host provides).
 * - Unregisters on unmount via the spec's AbortSignal semantics.
 * - `execute` always calls the **latest** render's closure, so the tool can
 *   read fresh state without re-registering.
 *
 * ```tsx
 * function NotesApp() {
 *   const [notes, setNotes] = useState<Note[]>([]);
 *   useMcpTool(defineTool({
 *     name: "search-notes",
 *     description: "키워드로 메모를 검색한다",
 *     inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
 *     execute: async ({ keyword }) => notes.filter((n) => n.text.includes(keyword)),
 *   }));
 *   // ^ reads the latest `notes` on every call — no stale closure.
 *   return <ul>{notes.map(/* … *\/)}</ul>;
 * }
 * ```
 *
 * `name`, `description` and `inputSchema` are the agent-facing contract and
 * are captured on mount; keep them stable for the component's lifetime.
 */

import { useEffect, useRef, useState } from "react";
import type { ToolDefinition } from "@webdesktopmcp/core";

export interface UseMcpToolResult {
  /** False until registration settles; an error message when registration failed. */
  registered: boolean;
  error?: string;
}

export function useMcpTool<TInput extends Record<string, unknown> = Record<string, unknown>>(
  definition: ToolDefinition<TInput>,
): UseMcpToolResult {
  // Always-fresh closure for execute (and nothing else — the agent-facing
  // contract stays as first registered).
  const latest = useRef(definition);
  latest.current = definition;

  // React state (not a ref): consumers must re-render when registration
  // settles, otherwise `registered` would never be observable.
  const [status, setStatus] = useState<UseMcpToolResult>({ registered: false });

  useEffect(() => {
    const mc = (document as unknown as Record<string, unknown>).modelContext as
      | {
          registerTool(tool: unknown, options?: unknown): Promise<undefined>;
        }
      | undefined;
    if (!mc || typeof mc.registerTool !== "function") {
      setStatus({
        registered: false,
        error: "document.modelContext is unavailable — did the host adapter install?",
      });
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    void mc
      .registerTool(
        {
          name: definition.name,
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: definition.annotations,
          // Delegate to the latest definition so execute sees fresh state.
          execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) =>
            latest.current.execute(input as TInput, options),
        },
        { signal: controller.signal },
      )
      .then(() => {
        if (!disposed) setStatus({ registered: true });
      })
      .catch((err: unknown) => {
        // An abort-triggered rejection is the cleanup path, not an error.
        if (!disposed && !controller.signal.aborted) {
          setStatus({
            registered: false,
            error: err instanceof Error ? err.message : String(err),
          });
          console.error(`[webdesktopmcp] useMcpTool("${definition.name}") failed:`, err);
        }
      });

    return () => {
      disposed = true;
      controller.abort();
    };
    // Re-register only when the tool identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.name]);

  return status;
}
