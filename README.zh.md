# webdesktopmcp

**把桌面应用(Electron · Tauri · Wails)变成 WebMCP 服务器。**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | 中文 | [Français](README.fr.md) | [Español](README.es.md)

只需几行代码，桌面应用的功能就能作为**工具暴露给 AI 代理**(Claude Desktop、Claude Code、Cursor、ChatGPT Desktop 等)。页面代码直接使用 [W3C WebMCP 草案](https://webmachinelearning.github.io/webmcp/)的标准 API(`document.modelContext`);当运行时提供原生 API 时会自动切换到真正的原生实现。

```ts
// 应用代码 — 直接使用 W3C WebMCP 标准 API
document.modelContext.registerTool({
  name: "search-orders",
  description: "按订单号或客户名搜索订单",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "订单号或客户名" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query }, { signal }) => searchOrders(query, signal),
});
```

```jsonc
// Claude Desktop 配置 — 应用运行中时,代理即可调用上述工具
{ "mcpServers": { "MyApp": {
    "command": "npx", "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }
```

## 工作原理

桌面 webview 还没有原生 WebMCP API(Electron 的 Chromium 低于 149;Tauri 使用 WKWebView/WebView2),因此本库桥接了三层:

```
[webview 中的页面]
  document.modelContext.registerTool(...)     ← polyfill 或原生镜像(同一 API)
        │  IPC — docs/protocol.md 线协议
        ▼
[原生宿主]  Electron main / Tauri(Rust) / Wails(Go)
  工具注册表 + 本地 MCP 服务器 (127.0.0.1,Bearer 令牌)
        │
        ├─ Streamable HTTP  ← Cursor、Claude Code 等直接连接
        └─ @webdesktopmcp/cli (stdio 垫片) ← Claude Desktop 等
```

**原生优先的版本门控** — Electron 适配器会检查 `process.versions.chrome`:

- **Chromium ≥ 149** → 通过 `--enable-blink-features=WebMCP` 开关启用原生 WebMCP。页面使用**真正的原生 `document.modelContext`**;适配器只透明地包装 `registerTool`,把注册镜像到外部代理(浏览器内置代理仍走原生路径)。
- **低于 149**(目前所有版本)→ 注入实现 W3C 语义的 polyfill。切换完全自动,无需修改应用代码。

## 包

| 包 | 语言 | 用途 |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | TS/Rust/Go 宿主共享的线协议([规范](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` polyfill + 原生镜像 + 声明式表单 API |
| [`@webdesktopmcp/server`](packages/server) | TS | 框架无关的本地 MCP 服务器 + 应用注册表 |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron 适配器(preload 自动注入、版本门控、确认对话框钩子) |
| [`@webdesktopmcp/cli`](packages/cli) | TS | `webdesktopmcp connect --app <名称>` stdio 垫片 |
| `crates/tauri-plugin-webdesktopmcp` | Rust | Tauri v2 插件 |
| `go/webdesktopmcp` | Go | Wails v2 包 |

## Electron 快速上手

```bash
npm i @webdesktopmcp/electron
```

```js
// main.js — 在 app.whenReady() 之前
const { installWebDesktopMcp } = require("@webdesktopmcp/electron");
const mcp = installWebDesktopMcp({
  appName: "MyApp",
  appVersion: "1.0.0",
  // 用原生确认对话框为敏感工具加门(可选)
  confirmToolCall: async (tool, input) => { /* dialog… */ return true; },
});

const win = new BrowserWindow({
  webPreferences: { preload: mcp.preloadPath },  // 推荐(也有会话级自动注册)
});
```

渲染进程里直接使用上面的标准 `document.modelContext.registerTool` 代码即可。需要类型推断时可用 `@webdesktopmcp/core` 的 `defineTool` 辅助函数（`execute` 内会推断输入类型）。调试时可在 DevTools 控制台调用 `window.__webDesktopMcp.listTools()` 查看页面注册的工具。还支持**声明式表单 API** — 无需一行 JavaScript,表单即是工具:

```html
<form toolname="order-coffee"
      tooldescription="订购咖啡。接受饮品类型和浓缩份数,返回订单号。"
      toolautosubmit>
  <select name="drink" toolparamdescription="饮品类型">
    <option value="americano">americano</option>
    <option value="latte">latte</option>
  </select>
  <input type="number" name="shots" toolparamdescription="浓缩份数" value="1" />
  <button type="submit">下单</button>
</form>
```

在表单的 submit 处理器中调用 `event.respondWith(result)`,该值就会返回给代理(`event.agentInvoked` 可判断是否由代理提交 — 即草案中 `SubmitEvent#respondWith` 的 polyfill)。

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
// 将 mcp 加入 options.Bind + 在 index.html 中注入 mcp.InitScript()
```

详见各目录的 README。

## 连接代理

```bash
# 查看运行中的应用
npx @webdesktopmcp/cli list

# 查看运行中应用的工具列表
npx @webdesktopmcp/cli tools --app "MyApp"

# Claude Desktop (stdio) — claude_desktop_config.json:
{ "mcpServers": { "MyApp": { "command": "npx",
    "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }

# 支持 HTTP 的客户端(Cursor、Claude Code 等)— 使用应用输出的值:
#   URL:   http://127.0.0.1:<port>/mcp
#   Token: ~/.webdesktopmcp/registry.json 中的 apps["MyApp"].token
```

端点仅绑定 `127.0.0.1`,且需要 Bearer 令牌。安全模型见 [docs/security.md](docs/security.md)。

## 演示

```bash
pnpm install
pnpm --filter webdesktopmcp-electron-demo start
# 应用运行中时,在另一个终端:
node packages/cli/dist/cli.js list
```

演示应用(`examples/electron-demo`)暴露 4 个命令式工具 + 1 个声明式表单工具(`order-coffee`)。在 Claude Desktop 里试试 *"显示未完成的任务"* 或 *"点一杯双份浓缩的拿铁"*。

## 验证状态

- `@webdesktopmcp/core` — vitest **19/19**(polyfill 语义、声明式表单、原生镜像)
- `@webdesktopmcp/server` — vitest **9/9**(注册表、HTTP MCP initialize/list/call、认证、暴露过滤、确认钩子)
- Electron 演示 — **真实应用 E2E 验证**:启动 → preload 注入 → 注册 5 个工具 → 通过 HTTP `tools/call` 调用命令式与声明式工具 → 并经 CLI stdio 垫片调用确认
- Tauri (Rust) / Wails (Go) — 通过 `cargo check`/`go build` 及各自测试套件验证(见各目录 README)

## 与 WebMCP 标准的关系

本库把 [W3C WebMCP CG 草案](https://webmachinelearning.github.io/webmcp)([repo](https://github.com/webmachinelearning/webmcp);Chrome 149 / Edge 150 起源试验)的页面端 API 带入桌面 webview。最早的 PoC 是 [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP),生态工具见 [MCP-B](https://mcp-b.ai)。技术研究全文(韩语):[webmcp-research.md](webmcp-research.md)。

## 许可证

MIT
