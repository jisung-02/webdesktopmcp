# webdesktopmcp

**데스크톱 앱(Electron · Tauri · Wails)을 WebMCP 서버로 바꿔주는 라이브러리.**

[English](README.md) | 한국어 | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

앱 개발자가 몇 줄만 추가하면, 앱의 기능이 AI 에이전트(Claude Desktop, Claude Code, Cursor, ChatGPT Desktop 등)에게 **도구(tool)로 노출**됩니다. 페이지 코드는 [W3C WebMCP 드래프트](https://webmachinelearning.github.io/webmcp/)의 표준 API(`document.modelContext`)를 그대로 사용하며, 런타임이 네이티브 API를 제공하면 자동으로 실제 네이티브로 전환됩니다.

```ts
// 앱 코드 — W3C WebMCP 표준 API 그대로
document.modelContext.registerTool({
  name: "search-orders",
  description: "주문번호 또는 고객명으로 주문을 검색한다",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "주문번호 또는 고객명" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query }, { signal }) => searchOrders(query, signal),
});
```

```jsonc
// Claude Desktop 설정 — 앱이 실행 중이면 에이전트가 위 도구를 호출한다
{ "mcpServers": { "내앱": {
    "command": "npx", "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "내앱"] } } }
```

## 동작 방식

데스크톱 웹뷰에는 네이티브 WebMCP API가 아직 없습니다(Electron의 Chromium은 149 미만, Tauri는 WKWebView/WebView2 사용). 그래서 라이브러리가 세 계층을 브리징합니다:

```
[웹뷰 안의 페이지]
  document.modelContext.registerTool(...)     ← 폴리필 또는 네이티브 미러 (같은 API)
        │  IPC — docs/protocol.md 와이어 프로토콜
        ▼
[네이티브 호스트]  Electron main / Tauri(Rust) / Wails(Go)
  도구 레지스트리 + 로컬 MCP 서버 (127.0.0.1, Bearer 토큰)
        │
        ├─ Streamable HTTP  ← Cursor, Claude Code 등 직접 연결
        └─ @webdesktopmcp/cli (stdio 셈)  ← Claude Desktop 등
```

**네이티브 우선 버전 게이트** — Electron 어댑터는 `process.versions.chrome`을 검사합니다:

- **Chromium ≥ 149** → `--enable-blink-features=WebMCP` 스위치로 네이티브 WebMCP를 켭니다. 페이지는 **진짜 네이티브 `document.modelContext`**를 사용하고, 어댑터는 `registerTool`만 투명하게 래핑해 등록을 외부 에이전트로 미러링합니다(브라우저 내장 에이전트는 네이티브 경로 그대로).
- **미만**(현재 전체) → W3C 시맨틱을 구현한 폴리필을 주입합니다. 전환은 자동이며 앱 코드 변경이 없습니다.

## 패키지

| 패키지 | 언어 | 용도 |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | TS/Rust/Go 호스트가 공유하는 와이어 프로토콜 ([명세](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` 폴리필 + 네이티브 미러 + 선언형 폼 API |
| [`@webdesktopmcp/server`](packages/server) | TS | 프레임워크 독립 로컬 MCP 서버 + 앱 레지스트리 |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron 어댑터 (프리로드 자동 주입, 버전 게이트, 확인 다이얼로그 훅) |
| [`@webdesktopmcp/cli`](packages/cli) | TS | `webdesktopmcp connect --app <이름>` stdio 셈 |
| `crates/tauri-plugin-webdesktopmcp` | Rust | Tauri v2 플러그인 |
| `go/webdesktopmcp` | Go | Wails v2 패키지 |

## Electron 빠른 시작

```bash
npm i @webdesktopmcp/electron
```

```js
// main.js — app.whenReady() 전에
const { installWebDesktopMcp } = require("@webdesktopmcp/electron");
const mcp = installWebDesktopMcp({
  appName: "내 앱",
  appVersion: "1.0.0",
  // 민감한 도구는 네이티브 확인 다이얼로그로 게이트 (선택)
  confirmToolCall: async (tool, input) => { /* dialog… */ return true; },
});

const win = new BrowserWindow({
  webPreferences: { preload: mcp.preloadPath },  // 권장 (세션 자동 등록도 있음)
});
```

렌더러에서는 위의 `document.modelContext.registerTool` 표준 코드만 쓰면 됩니다. **HTML 폼 선언형 API**도 지원합니다 — JS 한 줄 없이 폼이 곧 도구:

```html
<form toolname="order-coffee"
      tooldescription="커피를 주문한다. 음료 종류와 샷 수를 받아 주문 번호를 반환한다."
      toolautosubmit>
  <select name="drink" toolparamdescription="음료 종류">
    <option value="americano">americano</option>
    <option value="latte">latte</option>
  </select>
  <input type="number" name="shots" toolparamdescription="샷 수" value="1" />
  <button type="submit">주문</button>
</form>
```

폼의 submit 핸들러에서 `event.respondWith(result)`를 호출하면 그 값이 에이전트에게 반환됩니다(`event.agentInvoked`로 에이전트 호출 여부 판별 — 드래프트의 `SubmitEvent#respondWith`를 폴리필).

## Tauri (v2) / Wails (v2)

```rust
// Tauri — Rust
tauri::Builder::default()
    .plugin(tauri_plugin_webdesktopmcp::init(
        tauri_plugin_webdesktopmcp::WebDesktopMcpConfig::new("내 앱", "1.0.0"),
    ))
```

```go
// Wails — Go
mcp, _ := webdesktopmcp.New(webdesktopmcp.Config{AppName: "내 앱", AppVersion: "1.0.0"})
mcp.SetEventEmitter(func(event string, data ...interface{}) { runtime.EventsEmit(ctx, event, data...) })
// options.Bind에 mcp 추가 + index.html에 mcp.InitScript() 삽입
```

자세한 내용은 각 디렉터리의 README를 참고하세요.

## 에이전트 연결

```bash
# 실행 중인 앱 보기
npx @webdesktopmcp/cli list

# Claude Desktop (stdio) — claude_desktop_config.json:
{ "mcpServers": { "내 앱": { "command": "npx",
    "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "내 앱"] } } }

# HTTP 지원 클라이언트(Cursor, Claude Code 등) — 앱이 출력한 값 사용:
#   URL:   http://127.0.0.1:<port>/mcp
#   Token: ~/.webdesktopmcp/registry.json 의 apps["내 앱"].token
```

엔드포인트는 `127.0.0.1`에만 바인딩되고 Bearer 토큰이 필요합니다. 보안 모델: [docs/security.md](docs/security.md).

## 데모

```bash
pnpm install
pnpm --filter webdesktopmcp-electron-demo start
# 앱 실행 중에 다른 터미널에서:
node packages/cli/dist/cli.js list
```

데모 앱(`examples/electron-demo`)은 필수형 도구 4개 + 선언형 폼 도구(`order-coffee`)를 노출합니다. Claude Desktop에서 *"열린 할 일 보여줘"*, *"라떼 2샷 주문해줘"* 를 말해보세요.

## 검증 상태

- `@webdesktopmcp/core` — vitest **19/19** (폴리필 시맨틱, 선언형 폼, 네이티브 미러)
- `@webdesktopmcp/server` — vitest **9/9** (레지스트리, HTTP MCP initialize/list/call, 인증, 노출 필터, 확인 훅)
- Electron 데모 — **실제 앱 E2E 검증 완료**: 기동 → 프리로드 주입 → 도구 5개 등록 → HTTP `tools/call`로 필수형·선언형 도구 실행 → CLI stdio 셈 경유 호출까지 확인
- Tauri (Rust) / Wails (Go) — `cargo check`/`go build` 및 각 테스트 스위트로 검증 (각 디렉터리 README 참고)

## WebMCP 표준과의 관계

이 라이브러리는 [W3C WebMCP CG 드래프트](https://webmachinelearning.github.io/webmcp)([repo](https://github.com/webmachinelearning/webmcp), Chrome 149/Edge 150 오리진 트라이얼)의 페이지 측 API를 데스크톱 웹뷰로 가져옵니다. 원조 PoC는 [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP), 생태계 도구는 [MCP-B](https://mcp-b.ai). 기술 리서치 전문: [webmcp-research.md](webmcp-research.md).

## 라이선스

MIT
