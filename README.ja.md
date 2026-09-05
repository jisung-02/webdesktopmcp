# webdesktopmcp

**Electron · Tauri · Wails 向けの実験的なデスクトップ WebMCP-to-MCP ブリッジ**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

ページの関数をローカル MCP サーバーと CLI stdio 接続で外部エージェントに公開します。[2026-09-04 WebMCP CG 草案](https://webmachinelearning.github.io/webmcp/)は W3C 標準ではなく、W3C Standards Track にも属しません。本ライブラリは完全準拠を主張しません。

```ts
// Experimental WebMCP draft API
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

## 対応範囲 · 2026-09-05

ネイティブモードは実行時に `document.modelContext` の必要なメソッドを検出して選択します。バージョンやフラグだけでは利用可能性を保証できません。[Electron 44 は Chromium 152 を搭載](https://www.electronjs.org/blog/electron-44-0)し、[Chrome の origin trial は 149 から](https://developer.chrome.com/docs/ai/webmcp)です。

3 つのアダプターのポリフィルモードは共通実装と宣言的フォームの一部を提供します。ネイティブモードは導入後の命令的な `registerTool` 呼び出しだけをミラーリングし、ネイティブ宣言的フォームは外部 MCP に公開しません。両モードの動作は同一ではありません。

ブラウザーの iframe/Permissions Policy 全体や headless 実行の禁止は実装していません。JSON Schema による引数の実行時検証はツール側で行ってください。空でない `exposedTo` により外部の一覧取得と呼び出しを拒否するのはライブラリ独自の方針です。

## パッケージ

| パッケージ | 言語 | 役割 |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | TS/Rust/Go ホストが共有するワイヤプロトコル([仕様](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` ポリフィル + ネイティブミラー + 宣言型フォーム API |
| [`@webdesktopmcp/server`](packages/server) | TS | フレームワーク非依存のローカル MCP サーバー + アプリレジストリ |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron アダプタ(preload 自動注入、機能検出、確認ダイアログフック) |
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

レンダラーでは上記の草案 API の `document.modelContext.registerTool` コードを書くだけです。型推論が必要なら `@webdesktopmcp/core` の `defineTool` ヘルパーを使います（`execute` 内で入力型が推論されます）。デバッグ中は DevTools コンソールで `window.__webDesktopMcp.listTools()` を呼ぶとページが登録したツール一覧を確認できます。**宣言型フォーム API** もサポート — JavaScript なしでフォームがそのままツールになります:

```html
<!-- Polyfill mode: native declarative forms are not mirrored externally. -->
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

# 起動中アプリのツール一覧を確認
npx @webdesktopmcp/cli tools --app "MyApp"

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

ポリフィルモードの例: デモアプリ(`examples/electron-demo`)は命令型ツール 4 つ + 宣言型フォームツール(`order-coffee`)を公開します。Claude Desktop から *「未完了のタスクを見せて」*、*「ラテを 2 ショットで注文して」* と話しかけてみてください。

## 検証状況

導入・Tauri/Wails 設定・CLI は[英語版](README.md)を参照してください。機能と検証範囲の基準は[対応表](docs/support.md)、信頼境界は[セキュリティ文書](docs/security.md)です。ローカル自動テストは公式 WPT 準拠や全プラットフォームのネイティブ GUI 検証を意味しません。

```bash
pnpm build
pnpm test
pnpm typecheck
```

## WebMCP 草案との関係

ページの関数をローカル MCP サーバーと CLI stdio 接続で外部エージェントに公開します。[2026-09-04 WebMCP CG 草案](https://webmachinelearning.github.io/webmcp/)は W3C 標準ではなく、W3C Standards Track にも属しません。本ライブラリは完全準拠を主張しません。

[Support and verification](docs/support.md) · [Research notes](webmcp-research.md)

## ライセンス

MIT

[References and implementation evidence](docs/references.md)
