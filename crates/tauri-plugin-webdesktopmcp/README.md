# tauri-plugin-webdesktopmcp

Tauri v2 앱의 웹뷰를 WebMCP 서버로 만드는 플러그인.

## 사용법

```rust
use tauri_plugin_webdesktopmcp::{init, WebDesktopMcpConfig};

fn main() {
    tauri::Builder::default()
        .plugin(init(
            WebDesktopMcpConfig::new("내 앱", "1.0.0")
                .with_port(0), // 0 = 에페멀럴 포트
        ))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

부트스트랩 JS는 `on_page_load`(Started/Finished)에서 자동 주입되며, 파싱 전 주입이 필요하면 윈도우 빌더에서 직접 사용:

```rust
tauri::WebviewWindowBuilder::new(app, "main", Default::default())
    .initialization_script(tauri_plugin_webdesktopmcp::init_script())
    .build()?;
```

페이지 코드는 표준 WebMCP API 그대로: `document.modelContext.registerTool({ name, description, inputSchema, execute })`.

## API

| 항목 | 내용 |
|---|---|
| `init(WebDesktopMcpConfig) -> TauriPlugin<Wry>` | 플러그인 설치. 루프백 MCP 서버 기동 + `~/.webdesktopmcp/registry.json` 기록(드롭 시 제거) |
| `WebDesktopMcpConfig::new(app_name, app_version).with_port(u16)` | 설정 |
| `init_script() -> String` | 부트스트랩 JS(수동 `initialization_script`용) |
| `endpoint() -> Option<(String, String)>` | `(url, token)` — 에이전트 연결 안내용 |
| `#[command] send(window, message)` | JS→호스트 채널 (`webdesktopmcp:allow-send` 권한 기본 부여) |

## 부트스트랩 JS 동작

메인 월드에 `window.__webDesktopMcpHost {send, _deliver}`를 정의하고, 네이티브 `document.modelContext`가 있으면 **미러 모드**(native registerTool 래핑 → 호스트 중계), 없으면 **폴리필 모드**(registerTool/unregisterTool/getTools/executeTool, ontoolchange, AbortSignal 수명 시맨틱, 낙관적 등록 롤백)로 동작합니다. 선언형 `<form toolname>` API는 TS 코어에만 구현.

자동 주입은 페이지 로드 경계에서 `eval` 기반이라 페이지의 첫 스크립트보다 늦을 수 있습니다. 파싱 전 보장이 필요하면 위처럼 `initialization_script`를 사용하세요.

## 연결

앱 실행 중 `~/.webdesktopmcp/registry.json`의 엔드포인트로:

```bash
webdesktopmcp connect --app "내 앱"   # stdio 셈 (Claude Desktop)
# 또는 HTTP 직접 연결 (URL + Bearer 토큰)
```

## 검증

- `cargo check` / `cargo build` — 에러·경고 0
- `cargo test` — 19 유닛 + 2 통합(실제 HTTP 스모크, 레지스트리 파일) 통과
- 제한: MCP 클라이언트 연결 끊김 → abort 전파 없음(타임아웃 시 전파), Windows에서 데드-pid 프루닝 no-op, 전체 Tauri 앱 라이브 테스트는 미수행(컴파일 + 21개 자동 테스트로 담보). 리로드 시 재등록은 교체로 처리되지만, 새 페이지가 등록하지 않는 이전 도구는 창이 닫힐 때까지 남을 수 있음(TS 어댑터의 `did-navigate` 정리와 달리 내비게이션 전체 정리는 미구현).
