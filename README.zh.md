# webdesktopmcp

**面向 Electron · Tauri · Wails 的实验性桌面 WebMCP-to-MCP 桥接库**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

通过本地 MCP 服务器和 CLI stdio 连接向外部代理提供页面函数。[2026-09-04 WebMCP CG 草案](https://webmachinelearning.github.io/webmcp/)既不是 W3C 标准，也不属于 W3C Standards Track。本库不声称完全符合草案。

```ts
// Experimental WebMCP draft API
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

## 支持范围 · 2026-09-05

原生模式通过运行时检测 `document.modelContext` 所需方法来选择。版本号或功能开关不能保证可用性。[Electron 44 已包含 Chromium 152](https://www.electronjs.org/blog/electron-44-0)，[Chrome origin trial 从 149 开始](https://developer.chrome.com/docs/ai/webmcp)。

三个适配器的 polyfill 模式共享实现，并支持声明式表单的子集。原生模式仅镜像安装后命令式的 `registerTool` 调用，不向外部 MCP 镜像原生声明式表单。两种模式并非完全相同。

本库不完整实现浏览器 iframe/Permissions Policy，也不禁止无头执行。工具参数没有 JSON Schema 运行时验证，请在工具中验证。非空 `exposedTo` 会阻止外部发现和调用，这是本库的策略。

## 包

| 包 | 语言 | 用途 |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | TS/Rust/Go 宿主共享的线协议([规范](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` polyfill + 原生镜像 + 声明式表单 API |
| [`@webdesktopmcp/server`](packages/server) | TS | 框架无关的本地 MCP 服务器 + 应用注册表 |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron 适配器(preload 自动注入、功能检测、确认对话框钩子) |
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

渲染进程里直接使用上面的草案 API `document.modelContext.registerTool` 代码即可。需要类型推断时可用 `@webdesktopmcp/core` 的 `defineTool` 辅助函数（`execute` 内会推断输入类型）。调试时可在 DevTools 控制台调用 `window.__webDesktopMcp.listTools()` 查看页面注册的工具。还支持**声明式表单 API** — 无需一行 JavaScript,表单即是工具:

```html
<!-- Polyfill mode: native declarative forms are not mirrored externally. -->
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

Polyfill 模式示例：演示应用(`examples/electron-demo`)暴露 4 个命令式工具 + 1 个声明式表单工具(`order-coffee`)。在 Claude Desktop 里试试 *"显示未完成的任务"* 或 *"点一杯双份浓缩的拿铁"*。

## 验证状态

安装、Tauri/Wails 配置和 CLI 用法见[英文指南](README.md)。功能与验证范围以[支持矩阵](docs/support.md)为准，信任边界见[安全文档](docs/security.md)。本地自动测试不等同于官方 WPT 符合性测试或所有平台的原生 GUI 验证。

```bash
pnpm build
pnpm test
pnpm typecheck
```

## 与 WebMCP 草案的关系

通过本地 MCP 服务器和 CLI stdio 连接向外部代理提供页面函数。[2026-09-04 WebMCP CG 草案](https://webmachinelearning.github.io/webmcp/)既不是 W3C 标准，也不属于 W3C Standards Track。本库不声称完全符合草案。

[Support and verification](docs/support.md) · [Research notes](webmcp-research.md)

## 许可证

MIT

[References and implementation evidence](docs/references.md)
