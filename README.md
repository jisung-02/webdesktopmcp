# webdesktopmcp

**Turn desktop apps (Electron · Tauri · Wails) into WebMCP servers.**

English | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

With a few lines of code, desktop app developers can expose their app's features as **tools for AI agents** (Claude Desktop, Claude Code, Cursor, ChatGPT Desktop, …). Your page code uses the standard [W3C WebMCP draft](https://webmachinelearning.github.io/webmcp/) API (`document.modelContext`) as-is — and the library automatically switches to the real native API when the runtime ships it.

```ts
// App code — the standard W3C WebMCP API, unchanged
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

Desktop webviews don't ship the native WebMCP API yet (Electron's Chromium is below 149; Tauri uses WKWebView/WebView2), so the library bridges three layers:

```
[Page inside the webview]
  document.modelContext.registerTool(...)     ← polyfill or native mirror (same API)
        │  IPC — wire protocol in docs/protocol.md
        ▼
[Native host]  Electron main / Tauri (Rust) / Wails (Go)
  Tool registry + local MCP server (127.0.0.1, bearer token)
        │
        ├─ Streamable HTTP   ← Cursor, Claude Code, … connect directly
        └─ @webdesktopmcp/cli (stdio shim) ← Claude Desktop, …
```

**Native-first version gate** — the Electron adapter checks `process.versions.chrome`:

- **Chromium ≥ 149** → enables native WebMCP via the `--enable-blink-features=WebMCP` switch. The page uses the **real native `document.modelContext`**; the adapter only wraps `registerTool` transparently to mirror registrations out to external agents (built-in browser agents keep using the native path).
- **Below 149** (everything today) → injects a polyfill implementing the W3C semantics. The switch is automatic — no app code changes.

## Packages

| Package | Language | Purpose |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | Wire protocol shared by the TS/Rust/Go hosts ([spec](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` polyfill + native mirror + declarative form API |
| [`@webdesktopmcp/server`](packages/server) | TS | Framework-agnostic local MCP server + app registry |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron adapter (auto preload injection, version gate, confirmation hook) |
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

In the renderer, just use the standard `document.modelContext.registerTool` code shown above. **Declarative form API** is supported too — a form becomes a tool with zero JavaScript:

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

The demo app (`examples/electron-demo`) exposes 4 imperative tools plus a declarative form tool (`order-coffee`). From Claude Desktop, try *"show me open tasks"* or *"order a latte with 2 shots"*.

## Verification status

- `@webdesktopmcp/core` — vitest **19/19** (polyfill semantics, declarative forms, native mirror)
- `@webdesktopmcp/server` — vitest **9/9** (registry, HTTP MCP initialize/list/call, auth, exposure filter, confirmation hook)
- Electron demo — **verified end-to-end in a real app**: launch → preload injection → 5 tools registered → `tools/call` over HTTP for imperative and declarative tools → also invoked through the CLI stdio shim
- Tauri (Rust) / Wails (Go) — verified via `cargo check`/`go build` and their test suites (see each directory's README)

## Relation to the WebMCP standard

This library brings the page-side API of the [W3C WebMCP CG draft](https://webmachinelearning.github.io/webmcp/) ([repo](https://github.com/webmachinelearning/webmcp); origin trial in Chrome 149 / Edge 150) to desktop webviews. The original proof of concept is [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP); MCP-B ([site](https://mcp-b.ai)) builds ecosystem tooling. The underlying technical research (Korean): [webmcp-research.md](webmcp-research.md).

## License

MIT
