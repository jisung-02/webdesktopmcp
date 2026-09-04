export {
  ModelContext,
  installModelContextPolyfill,
  type PolyfillInternals,
} from "./polyfill.js";
export {
  bootstrapWebDesktopMcp,
  type BootstrapHandle,
  type BootstrapOptions,
  type NativePreference,
} from "./bootstrap.js";
export { installNativeModelContextMirror } from "./native-mirror.js";
export { defineTool, type ToolDefinition } from "./define-tool.js";
export type {
  HostBridgeLike,
  InstalledPolyfill,
  ModelContextExecuteToolOptions,
  ModelContextGetToolOptions,
  ModelContextRegisterToolOptions,
  ModelContextTool,
  PolyfillInstallOptions,
  RegisteredToolInfo,
  ToolExecuteCallback,
  ToolExecuteCallbackOptions,
} from "./types.js";
