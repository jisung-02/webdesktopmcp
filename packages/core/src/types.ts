/**
 * Public API types mirroring the W3C WebMCP draft so developer code written
 * against the spec types compiles unchanged against this polyfill.
 */

import type { JsonSchemaObject, ToolAnnotations } from "@webdesktopmcp/protocol";

export type { JsonSchemaObject, ToolAnnotations };

export interface ToolExecuteCallbackOptions {
  /** Aborted when the agent (or the app) cancels the invocation. */
  signal: AbortSignal;
}

export type ToolExecuteCallback = (
  input: Record<string, unknown>,
  options: ToolExecuteCallbackOptions,
) => Promise<unknown>;

export interface ModelContextTool {
  /** 1–128 chars of [A-Za-z0-9_.-]. */
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  execute: ToolExecuteCallback;
  annotations?: ToolAnnotations;
}

export interface ModelContextRegisterToolOptions {
  /** Restrict exposure to these origins (default: all agents served by the host). */
  exposedTo?: (string | URL)[];
  /** Aborting unregisters the tool (spec behaviour). */
  signal?: AbortSignal;
}

export interface ModelContextGetToolOptions {
  /** Only return tools from these origins. */
  fromOrigins?: (string | URL)[];
  signal?: AbortSignal;
}

export interface ModelContextExecuteToolOptions {
  /** Only match tools registered by these origins. */
  fromOrigins?: (string | URL)[];
  signal?: AbortSignal;
}

/** Result of getTools(): a read-only snapshot of another document's tool. */
export interface RegisteredToolInfo {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  annotations?: ToolAnnotations;
  /** Origin of the document that registered the tool. */
  origin: string;
  /** Host-assigned frame identifier (webview label / webContents id). */
  frameId: string;
}

export interface HostBridgeLike {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
}

export interface PolyfillInstallOptions {
  bridge: HostBridgeLike;
  /** Host-assigned frame identifier. */
  frameId: string;
  appName: string;
  appVersion: string;
  /**
   * Install even when `window.isSecureContext` is false or a native
   * `document.modelContext` already exists. Use with care.
   */
  force?: boolean;
  /** Enable the declarative `<form toolname=...>` API. Default: true. */
  declarative?: boolean;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

export interface InstalledPolyfill {
  /** Remove the polyfill, unregistering everything it registered. */
  dispose(): void;
  /** Internal diagnostics. */
  readonly registeredToolNames: readonly string[];
}
