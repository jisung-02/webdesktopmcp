/**
 * `defineTool` — a typed authoring helper.
 *
 * Purely compile-time sugar: the returned object IS a ModelContextTool and
 * behaves identically when passed to `document.modelContext.registerTool`.
 * The value is input-type inference inside `execute` — without it, `input`
 * is `Record<string, unknown>` and typos ship silently.
 *
 * ```ts
 * const search = defineTool<{ keyword: string }>({
 *   name: "search-notes",
 *   description: "키워드로 메모를 검색한다",
 *   inputSchema: {
 *     type: "object",
 *     properties: { keyword: { type: "string", description: "검색 키워드" } },
 *     required: ["keyword"],
 *   },
 *   execute: async ({ keyword }, { signal }) => {
 *     //            ^^^^^^^ typed: string — not Record<string, unknown>
 *     return notes.filter((n) => n.text.includes(keyword));
 *   },
 * });
 * document.modelContext.registerTool(search);
 * ```
 */

import type { JsonSchemaObject, ModelContextTool, ToolAnnotations } from "./types.js";

export interface ToolDefinition<TInput extends Record<string, unknown>> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  annotations?: ToolAnnotations;
  execute: (input: TInput, options: { signal: AbortSignal }) => Promise<unknown>;
}

export function defineTool<TInput extends Record<string, unknown> = Record<string, unknown>>(
  definition: ToolDefinition<TInput>,
): ModelContextTool {
  return definition as unknown as ModelContextTool;
}
