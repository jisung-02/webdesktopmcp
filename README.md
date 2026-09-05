# webdesktopmcp

**An experimental desktop WebMCP-to-MCP bridge for Electron, Tauri, and Wails.**

English | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

Expose page functions as tools to external MCP clients over a local authenticated endpoint. The page API follows a subset of the [WebMCP Community Group draft](https://webmachinelearning.github.io/webmcp/). The 4 September 2026 draft is **neither a W3C Standard nor on the W3C Standards Track**. This library does not claim full browser conformance. The [support matrix](docs/support.md) is the source of truth for supported behavior and verification scope.

```ts
// Page tool registration — experimental WebMCP draft API
document.modelContext.registerTool({
  name: "search-orders",
  description: "Search orders by order number or customer name",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Order number or customer name" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query }, { signal }) => searchOrders(query, signal),
});
```

```jsonc
// Claude Desktop config — once the app is running, agents can call the tools above
{ "mcpServers": { "MyApp": {
    "command": "npx", "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }
```

## How it works

The bridge connects page registrations to an external MCP transport:

```
Page: document.modelContext.registerTool(...)
  → shared page polyfill or native registration mirror
  → host IPC (Electron / Tauri / Wails)
  → local tool registry and MCP server (127.0.0.1, bearer token)
  → HTTP MCP client or @webdesktopmcp/cli stdio shim
```

Native mode is selected by feature detection of the required `document.modelContext` methods; a Chromium version or feature flag does not guarantee availability or draft compatibility. Electron may request the experimental feature flag on eligible versions. [Electron 44 already includes Chromium 152](https://www.electronjs.org/blog/electron-44-0), while [Chrome documents an origin trial starting in 149](https://developer.chrome.com/docs/ai/webmcp).

The native mirror observes imperative `registerTool` calls made after installation. Native browser declarative forms are **not mirrored to external MCP clients**. Polyfill mode provides the library's declarative form subset on all three adapters. Browser Permissions Policy, origin isolation, and native-agent behavior are not reproduced in full; see the [support matrix](docs/support.md).

## Packages

| Package | Language | Purpose |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | Wire protocol shared by the TS/Rust/Go hosts ([spec](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` polyfill + native mirror + declarative form API |
| [`@webdesktopmcp/server`](packages/server) | TS | Framework-agnostic local MCP server + app registry |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron adapter (auto preload injection, feature detection, confirmation hook) |
| [`@webdesktopmcp/cli`](packages/cli) | TS | `webdesktopmcp connect --app <name>` stdio shim |
| `crates/tauri-plugin-webdesktopmcp` | Rust | Tauri v2 plugin |
| `go/webdesktopmcp` | Go | Wails v2 package |

## Electron quick start

```bash
npm i @webdesktopmcp/electron
```

```js
// main.js — before app.whenReady()
const { installWebDesktopMcp } = require("@webdesktopmcp/electron");
const mcp = installWebDesktopMcp({
  appName: "MyApp",
  appVersion: "1.0.0",
  // Gate sensitive tools behind a native confirmation dialog (optional)
  confirmToolCall: async (tool, input) => { /* dialog… */ return true; },
});

const win = new BrowserWindow({
  webPreferences: { preload: mcp.preloadPath },  // recommended (session auto-registration also exists)
});
```

In the renderer, just use the `document.modelContext.registerTool` code shown above. For typed inputs, use the `defineTool` helper from `@webdesktopmcp/core` (the object it returns is a plain `ModelContextTool` — input types are inferred inside `execute`):

```ts
import { defineTool } from "@webdesktopmcp/core";

const search = defineTool<{ keyword: string }>({
  name: "search-notes",
  description: "Search notes by keyword",
  inputSchema: { /* … */ },
  execute: async ({ keyword }) => { /* keyword: string ✅ */ },
});
```

While debugging, `window.__webDesktopMcp.listTools()` in DevTools shows everything the page registered, and **polyfill mode supports a declarative form subset** — annotated forms become tools:

```html
<form toolname="order-coffee"
      tooldescription="Order a coffee. Takes a drink type and shot count, returns an order number."
      toolautosubmit>
  <select name="drink" toolparamdescription="Drink type">
    <option value="americano">americano</option>
    <option value="latte">latte</option>
  </select>
  <input type="number" name="shots" toolparamdescription="Number of shots" value="1" />
  <button type="submit">Order</button>
</form>
```

Call `event.respondWith(result)` in the form's submit handler and that value is returned to the agent (`event.agentInvoked` tells you an agent submitted the form — the draft's `SubmitEvent#respondWith`, polyfilled).

## Tauri (v2) / Wails (v2)

```rust
// Tauri — Rust
tauri::Builder::default()
    .plugin(tauri_plugin_webdesktopmcp::init(
        tauri_plugin_webdesktopmcp::WebDesktopMcpConfig::new("MyApp", "1.0.0"),
    ))
```

```go
// Wails — Go
mcp, _ := webdesktopmcp.New(webdesktopmcp.Config{AppName: "MyApp", AppVersion: "1.0.0"})
mcp.SetEventEmitter(func(event string, data ...interface{}) { runtime.EventsEmit(ctx, event, data...) })
// add mcp to options.Bind + inject mcp.InitScript() into index.html
```

See each directory's README for details.

## Connecting agents

```bash
# List running apps
npx @webdesktopmcp/cli list

# Inspect a running app's tools (names, descriptions, required params)
npx @webdesktopmcp/cli tools --app "MyApp"

# Claude Desktop (stdio) — claude_desktop_config.json:
{ "mcpServers": { "MyApp": { "command": "npx",
    "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }

# HTTP-capable clients (Cursor, Claude Code, …) — use what the app printed:
#   URL:   http://127.0.0.1:<port>/mcp
#   Token: apps["MyApp"].token in ~/.webdesktopmcp/registry.json
```

The endpoint binds to `127.0.0.1` only and requires a bearer token. Security model: [docs/security.md](docs/security.md).

## Demo

```bash
pnpm install
pnpm --filter webdesktopmcp-electron-demo start
# in another terminal, while the app is running:
node packages/cli/dist/cli.js list
```

The demo app (`examples/electron-demo`) includes imperative tools and, in polyfill mode, a declarative form tool (`order-coffee`). From Claude Desktop, try *"show me open tasks"* or *"order a latte with 2 shots"*.

## Verification status

As of 2026-09-05, repository checks cover the shared page implementation, native-shaped fixtures, host authorization/HTTP behavior, React lifecycle, and adapter source/build checks. These are local automated checks; they do not establish official Web Platform Tests conformance or end-to-end native GUI coverage for every platform. A real Electron 38.8.6 / Chromium 140.0.7339.249 polyfill integration smoke passed on 2026-09-05; its exact scope and rerun command are recorded in the [support document](docs/support.md#recorded-electron-integration-run). This does not verify the native WebMCP path.

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
(cd go/webdesktopmcp && go test ./...)
(cd crates/tauri-plugin-webdesktopmcp && cargo test)
```

Consult [support and verification scope](docs/support.md), [security](docs/security.md), and the updated [research notes (Korean)](webmcp-research.md) before integrating the experimental bridge.

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull requests; [SUPPORT.md](.github/SUPPORT.md) for help; and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation guidelines. Report vulnerabilities using [SECURITY.md](SECURITY.md).

Assistant guidance: [AGENTS.md](AGENTS.md) and [tool setup](docs/ai-assistants.md).

## License

[MIT](LICENSE). License copies are included in each distributable package.

[References and implementation evidence](docs/references.md)
