# webdesktopmcp

**Electron · Tauri · Wails를 위한 실험적 데스크톱 WebMCP-to-MCP 브리지**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

페이지 함수를 로컬 MCP 서버와 CLI stdio 연결을 통해 외부 에이전트에 제공합니다. [2026-09-04 WebMCP CG 초안](https://webmachinelearning.github.io/webmcp/)은 W3C 표준도, W3C Standards Track 문서도 아닙니다. 이 라이브러리는 전체 적합성을 주장하지 않습니다.

```ts
// Experimental WebMCP draft API
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

## 지원 범위 · 2026-09-05

네이티브 모드는 실행 시 `document.modelContext`의 필요한 메서드를 감지해 선택합니다. 버전이나 플래그만으로 제공 여부를 보장하지 않습니다. [Electron 44는 Chromium 152를 포함](https://www.electronjs.org/blog/electron-44-0)하며 [Chrome origin trial은 149부터](https://developer.chrome.com/docs/ai/webmcp)입니다.

세 어댑터의 폴리필 모드는 공통 구현과 선언형 폼 부분집합을 제공합니다. 네이티브 모드는 설치 후의 명령형 `registerTool` 호출만 미러링하며 네이티브 선언형 폼은 외부 MCP에 노출하지 않습니다. 두 모드의 동작은 동일하지 않습니다.

브라우저의 전체 iframe/Permissions Policy를 구현하지 않으며 headless 실행을 금지하지도 않습니다. JSON Schema 입력을 런타임 검증하지 않으므로 도구에서 검증하세요. 비어 있지 않은 `exposedTo`는 외부 조회·호출을 차단하는 라이브러리 정책입니다.

## 패키지

| 패키지 | 언어 | 용도 |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | TS/Rust/Go 호스트가 공유하는 와이어 프로토콜 ([명세](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | `document.modelContext` 폴리필 + 네이티브 미러 + 선언형 폼 API |
| [`@webdesktopmcp/server`](packages/server) | TS | 프레임워크 독립 로컬 MCP 서버 + 앱 레지스트리 |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Electron 어댑터 (프리로드 자동 주입, 기능 감지, 확인 다이얼로그 훅) |
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

렌더러에서는 위의 `document.modelContext.registerTool` 초안 API 코드만 쓰면 됩니다. 타입 추론이 필요하면 `@webdesktopmcp/core`의 `defineTool` 헬퍼를 쓰세요(반환값은 그냥 `ModelContextTool` — `execute` 안에서 입력 타입이 추론됩니다):

```ts
import { defineTool } from "@webdesktopmcp/core";

const search = defineTool<{ keyword: string }>({
  name: "search-notes",
  description: "키워드로 메모를 검색한다",
  inputSchema: { /* … */ },
  execute: async ({ keyword }) => { /* keyword: string ✅ */ },
});
```

디버깅 중에는 DevTools 콘솔에서 `window.__webDesktopMcp.listTools()`로 페이지가 등록한 도구를 볼 수 있습니다. **HTML 폼 선언형 API**도 지원합니다 — JS 한 줄 없이 폼이 곧 도구:

```html
<!-- Polyfill mode: native declarative forms are not mirrored externally. -->
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

# 실행 중인 앱의 도구 목록·필수 파라미터 조회
npx @webdesktopmcp/cli tools --app "내 앱"

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

폴리필 모드 예시: 데모 앱(`examples/electron-demo`)은 필수형 도구 4개 + 선언형 폼 도구(`order-coffee`)를 노출합니다. Claude Desktop에서 *"열린 할 일 보여줘"*, *"라떼 2샷 주문해줘"* 를 말해보세요.

## 검증 상태

설치·Tauri/Wails 설정·CLI 사용법은 [영문 안내](README.md)를 참고하세요. 기능과 검증 범위의 단일 기준은 [지원 표](docs/support.md), 보안 경계는 [보안 모델](docs/security.md)입니다. 로컬 자동 테스트는 공식 WPT 적합성이나 모든 플랫폼 네이티브 GUI 검증을 의미하지 않습니다.

```bash
pnpm build
pnpm test
pnpm typecheck
```

## WebMCP 초안과의 관계

페이지 함수를 로컬 MCP 서버와 CLI stdio 연결을 통해 외부 에이전트에 제공합니다. [2026-09-04 WebMCP CG 초안](https://webmachinelearning.github.io/webmcp/)은 W3C 표준도, W3C Standards Track 문서도 아닙니다. 이 라이브러리는 전체 적합성을 주장하지 않습니다.

[Support and verification](docs/support.md) · [Research notes](webmcp-research.md)

## 라이선스

MIT

[References and implementation evidence](docs/references.md)
