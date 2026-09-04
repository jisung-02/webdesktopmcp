# webdesktopmcp

**デスクトップアプリ(Electron · Tauri · Wails)を WebMCP サーバーに変えるライブラリ。**

[English](README.md) | [한국어](README.ko.md) | 日本語 | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

数行のコードを追加するだけで、デスクトップアプリの機能を AI エージェント(Claude Desktop、Claude Code、Cursor、ChatGPT Desktop など)に**ツールとして公開**できます。ページのコードは [W3C WebMCP ドラフト](https://webmachinelearning.github.io/webmcp/)の標準 API(`document.modelContext`)をそのまま使用し、ランタイムがネイティブ APIを提供すれば自動的に本物のネイティブ実装へ切り替わります。

```ts
// アプリコード — W3C WebMCP 標準 API をそのまま
document.modelContext.registerTool({
  name: "search-orders",
  description: "注文番号または顧客名で注文を検索する",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "注文番号または顧客名" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query }, { signal }) => searchOrders(query, signal),
});
```

```jsonc
// Claude Desktop の設定 — アプリが起動していればエージェントが上記ツールを呼び出せる
{ "mcpServers": { "MyApp": {
    "command": "npx", "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }
```

## 仕組み

デスクトップのウェブビューにはネイティブ WebMCP APIがまだありません(Electron の Chromium は 149 未満、Tauri は WKWebView/WebView2 を使用)。そこでライブラリが 3 つのレイヤーをブリッジします:

```
[ウェブビュー内のページ]
  document.modelContext.registerTool(...)     ← ポリフィルまたはネイティブミラー(同じ API)
        │  IPC — docs/protocol.md のワイヤプロトコル
        ▼
[ネイティブホスト]  Electron main / Tauri(Rust) / Wails(Go)
  ツールレジストリ + ローカル MCP サーバー (127.0.0.1、Bearer トークン)
        │
        ├─ Streamable HTTP  ← Cursor、Claude Code などが直接接続
        └─ @webdesktopmcp/cli (stdio シム) ← Claude Desktop など
```

**ネイティブ優先のバージョンゲート** — Electron アダプタは `process.versions.chrome` を確認します:

- **Chromium ≥ 149** → `--enable-blink-features=WebMCP` スイッチでネイティブ WebMCP を有効化。ページは**本物のネイティブ `document.modelContext`** を使い、アダプタは `registerTool` を透過的にラップして登録を外部エージェントへミラーリングします(ブラウザ内蔵エージェントはネイティブ経路をそのまま使用)。
- **未満**(現状すべて)→ W3C セマンティクスを実装したポリフィルを注入します。切り替えは自動で、アプリコードの変更は不要です。

## パッケージ

| パッケージ | 言語 | 役割 |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | TS/Rust/Go ホストが共有するワイヤプロトコル([仕様](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` ポリフィル + ネイティブミラー + 宣言型フォーム API |
| [`@webdesktopmcp/server`](packages/server) | TS | フレームワーク非依存のローカル MCP サーバー + アプリレジストリ |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron アダプタ(preload 自動注入、バージョンゲート、確認ダイアログフック) |
| [`@webdesktopmcp/cli`](packages/cli) | TS | `webdesktopmcp connect --app <名前>` stdio シム |
| `crates/tauri-plugin-webdesktopmcp` | Rust | Tauri v2 プラグイン |
| `go/webdesktopmcp` | Go | Wails v2 パッケージ |

## Electron クイックスタート

```bash
npm i @webdesktopmcp/electron
```

```js
// main.js — app.whenReady() の前に
const { installWebDesktopMcp } = require("@webdesktopmcp/electron");
const mcp = installWebDesktopMcp({
  appName: "MyApp",
  appVersion: "1.0.0",
  // 機密性の高いツールをネイティブ確認ダイアログでゲート(任意)
  confirmToolCall: async (tool, input) => { /* dialog… */ return true; },
});

const win = new BrowserWindow({
  webPreferences: { preload: mcp.preloadPath },  // 推奨(セッション自動登録もある)
});
```

レンダラーでは上記の標準 `document.modelContext.registerTool` コードを書くだけです。**宣言型フォーム API** もサポート — JavaScript なしでフォームがそのままツールになります:

```html
<form toolname="order-coffee"
      tooldescription="コーヒーを注文する。ドリンクの種類とショット数を受け取り、注文番号を返す。"
      toolautosubmit>
  <select name="drink" toolparamdescription="ドリンクの種類">
    <option value="americano">americano</option>
    <option value="latte">latte</option>
  </select>
  <input type="number" name="shots" toolparamdescription="ショット数" value="1" />
  <button type="submit">注文</button>
</form>
```

フォームの submit ハンドラで `event.respondWith(result)` を呼ぶと、その値がエージェントに返されます(`event.agentInvoked` でエージェントからの送信か判定可能 — ドラフトの `SubmitEvent#respondWith` をポリフィル)。

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
// options.Bind に mcp を追加 + index.html に mcp.InitScript() を注入
```

詳細は各ディレクトリの README を参照してください。

## エージェントの接続

```bash
# 起動中のアプリ一覧
npx @webdesktopmcp/cli list

# Claude Desktop (stdio) — claude_desktop_config.json:
{ "mcpServers": { "MyApp": { "command": "npx",
    "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }

# HTTP 対応クライアント(Cursor、Claude Code など)— アプリが出力した値を使用:
#   URL:   http://127.0.0.1:<port>/mcp
#   Token: ~/.webdesktopmcp/registry.json の apps["MyApp"].token
```

エンドポイントは `127.0.0.1` のみにバインドし、Bearer トークンが必要です。セキュリティモデル: [docs/security.md](docs/security.md)。

## デモ

```bash
pnpm install
pnpm --filter webdesktopmcp-electron-demo start
# アプリ起動中に別ターミナルで:
node packages/cli/dist/cli.js list
```

デモアプリ(`examples/electron-demo`)は命令型ツール 4 つ + 宣言型フォームツール(`order-coffee`)を公開します。Claude Desktop から *「未完了のタスクを見せて」*、*「ラテを 2 ショットで注文して」* と話しかけてみてください。

## 検証状況

- `@webdesktopmcp/core` — vitest **19/19**(ポリフィルセマンティクス、宣言型フォーム、ネイティブミラー)
- `@webdesktopmcp/server` — vitest **9/9**(レジストリ、HTTP MCP initialize/list/call、認証、公開フィルタ、確認フック)
- Electron デモ — **実アプリでの E2E 検証済み**:起動 → preload 注入 → ツール 5 件登録 → HTTP `tools/call` で命令型・宣言型ツールを実行 → CLI stdio シム経由の呼び出しまで確認
- Tauri (Rust) / Wails (Go) — `cargo check`/`go build` および各テストスイートで検証(各ディレクトリの README を参照)

## WebMCP 標準との関係

このライブラリは、[W3C WebMCP CG ドラフト](https://webmachinelearning.github.io/webmcp)([repo](https://github.com/webmachinelearning/webmcp)、Chrome 149 / Edge 150 でオリジントライアル)のページ側 API をデスクトップのウェブビューに持ち込みます。元祖 PoC は [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP)、エコシステムは [MCP-B](https://mcp-b.ai)。技術リサーチ全文(韓国語): [webmcp-research.md](webmcp-research.md)。

## ライセンス

MIT
