/**
 * @webdesktopmcp/protocol
 *
 * The wire contract between the WebMCP polyfill running inside a webview and
 * the desktop host process (Electron main / Tauri core / Wails Go backend).
 *
 * Design mirrors the W3C WebMCP CG draft (webmachinelearning.github.io/webmcp)
 * so that code written against the standard API keeps working when browsers
 * ship the native API.
 */

/** Global name exposed on `window` by every adapter's preload/initialisation script. */
export const HOST_BRIDGE_GLOBAL = "__webDesktopMcpHost" as const;

/** Protocol version. Bump on breaking wire changes; hosts reject mismatches. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Tool declarations (subset-aligned with W3C `ModelContextTool`)
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  /** Hint: the tool does not modify meaningful state. */
  readOnlyHint?: boolean;
  /** Hint: tool output may contain content an agent must not treat as instructions. */
  untrustedContentHint?: boolean;
}

export interface JsonSchemaObject {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDeclaration {
  /** 1–128 chars, `[A-Za-z0-9_.-]` only — matches the W3C draft grammar. */
  name: string;
  /** Human-facing title shown in agent UIs. */
  title?: string;
  /** Natural-language description the agent relies on. Required by the spec. */
  description: string;
  /** JSON Schema describing the input object. */
  inputSchema?: JsonSchemaObject;
  annotations?: ToolAnnotations;
}

/** A tool as tracked by the host, enriched with frame provenance. */
export interface RegisteredToolInfo extends ToolDeclaration {
  /** Origin (e.g. `http://localhost:3000`, `file://`) of the registering document. */
  origin: string;
  /** Host-assigned frame/webview label (e.g. Electron `webContents.id`, Tauri webview label). */
  frameId: string;
  /** Origins the tool is restricted to (from `registerTool` `exposedTo`). */
  exposedTo?: string[];
}

// ---------------------------------------------------------------------------
// Host bridge (injected as `window.__webDesktopMcpHost`)
// ---------------------------------------------------------------------------

export interface HostInit {
  kind: "init";
  protocolVersion: number;
  appName: string;
  appVersion: string;
  frameId: string;
  origin: string;
  /** Features the host supports, so the polyfill can degrade gracefully. */
  capabilities: {
    /** Host delivers `toolchange` for tools registered in *other* frames. */
    crossFrameEvents: boolean;
    /** Host supports getTools() aggregation across frames. */
    crossFrameGetTools: boolean;
  };
}

export interface RegisterToolMessage {
  kind: "register";
  invocationId: string;
  tool: ToolDeclaration;
  /** Origin exposure list from `registerTool(tool, { exposedTo })`. */
  exposedTo?: string[];
}

export interface UnregisterToolMessage {
  kind: "unregister";
  invocationId: string;
  name: string;
}

export interface ExecuteResultMessage {
  kind: "executeResult";
  invocationId: string;
  ok: boolean;
  /** JSON-serialised tool result (already stringified by the polyfill). */
  result?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Host → registering frame: outcome of a `register` (e.g. name clash across frames). */
export interface RegisterResultMessage {
  kind: "registerResult";
  invocationId: string;
  ok: boolean;
  errorMessage?: string;
}

/** Caller frame → host: an in-page agent calls `executeTool()` on another frame's tool. */
export interface ExecuteForwardRequestMessage {
  kind: "executeForward";
  requestId: string;
  name: string;
  input: unknown;
  fromOrigin: string;
}

/** Host → caller frame: result of a forwarded `executeTool()`. */
export interface ExecuteForwardResultMessage {
  kind: "executeForwardResult";
  requestId: string;
  ok: boolean;
  result?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface GetToolsRequestMessage {
  kind: "getToolsRequest";
  requestId: string;
  /** Restrict results to these origins. */
  fromOrigins?: string[];
  /** Only tools exposed to this origin. */
  forOrigin: string;
}

export interface GetToolsResponseMessage {
  kind: "getToolsResponse";
  requestId: string;
  tools: RegisteredToolInfo[];
}

export interface ToolRemovedNoticeMessage {
  kind: "toolRemoved";
  name: string;
  frameId: string;
}

export interface LogMessage {
  kind: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** Messages sent from the webview to the host. */
export type RendererMessage =
  | RegisterToolMessage
  | UnregisterToolMessage
  | ExecuteResultMessage
  | ExecuteForwardRequestMessage
  | GetToolsRequestMessage
  | ToolRemovedNoticeMessage
  | LogMessage;

export interface ExecuteToolHostMessage {
  kind: "execute";
  invocationId: string;
  name: string;
  /** Input object as delivered by the agent (unvalidated JSON value). */
  input: unknown;
}

export interface AbortToolHostMessage {
  kind: "abort";
  invocationId: string;
}

export interface ToolsChangedHostMessage {
  kind: "toolsChanged";
  /** Registered tools across the app, filtered for this frame's origin. */
  tools: RegisteredToolInfo[];
}

/** Messages sent from the host to the webview. */
export type HostMessage =
  | HostInit
  | ExecuteToolHostMessage
  | AbortToolHostMessage
  | ToolsChangedHostMessage
  | GetToolsResponseMessage
  | RegisterResultMessage
  | ExecuteForwardResultMessage;

/** Transport every adapter exposes to the main world. */
export interface HostBridge {
  send(message: RendererMessage): void;
  onMessage(handler: (message: HostMessage) => void): () => void;
}

// ---------------------------------------------------------------------------
// Validation helpers (spec: name 1–128 chars of [A-Za-z0-9_.-])
// ---------------------------------------------------------------------------

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME_RE.test(name);
}

export function validateToolDeclaration(decl: unknown): ToolDeclaration {
  if (typeof decl !== "object" || decl === null) {
    throw new TypeError("Tool must be an object.");
  }
  const d = decl as Record<string, unknown>;
  if (!isValidToolName(d.name)) {
    throw new TypeError(
      `Invalid tool name: must be 1–128 characters of [A-Za-z0-9_.-], got ${JSON.stringify(d.name)}.`,
    );
  }
  if (typeof d.description !== "string" || d.description.length === 0) {
    throw new TypeError(`Tool "${d.name}": description is required and must be a non-empty string.`);
  }
  if (d.inputSchema !== undefined) {
    if (typeof d.inputSchema !== "object" || d.inputSchema === null) {
      throw new TypeError(`Tool "${d.name}": inputSchema must be a JSON Schema object.`);
    }
    const schema = d.inputSchema as Record<string, unknown>;
    if (typeof schema.type !== "string") {
      throw new TypeError(`Tool "${d.name}": inputSchema.type must be a string.`);
    }
  }
  if (d.annotations !== undefined && (typeof d.annotations !== "object" || d.annotations === null)) {
    throw new TypeError(`Tool "${d.name}": annotations must be an object.`);
  }
  return {
    name: d.name,
    title: typeof d.title === "string" ? d.title : undefined,
    description: d.description,
    inputSchema: d.inputSchema as JsonSchemaObject | undefined,
    annotations: (d.annotations as ToolAnnotations | undefined) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// App registry (how the CLI shim finds running apps)
// ---------------------------------------------------------------------------

/**
 * Each running desktop app writes its endpoint here so stdio shims can find it.
 * Location: `<userData>/webdesktopmcp/registry.json` (Electron) or an
 * OS-equivalent per-platform path resolved by `registryFilePath()`.
 */
export interface AppRegistryEntry {
  /** User-facing app name (also the shim lookup key). */
  appName: string;
  /** Streamable-HTTP MCP endpoint, always loopback. */
  url: string;
  /** Bearer token required by the endpoint. */
  token: string;
  pid: number;
  /** Library version that wrote the entry. */
  protocolVersion: number;
  updatedAt: string;
}

export interface AppRegistry {
  apps: Record<string, AppRegistryEntry>;
}

export function normalizeOrigin(url: string): string {
  try {
    const u = new URL(url);
    // file: URLs have an opaque origin; keep the full URL as the origin key.
    if (u.protocol === "file:") return url;
    return u.origin;
  } catch {
    return url;
  }
}
