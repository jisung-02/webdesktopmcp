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

페이지 등록 API (실험적 CG 초안의 부분 구현): `document.modelContext.registerTool({ name, description, inputSchema, execute })`.

## API

| 항목 | 내용 |
|---|---|
| `init(WebDesktopMcpConfig) -> TauriPlugin<Wry>` | 플러그인 설치. 루프백 MCP 서버 기동 + `~/.webdesktopmcp/registry.json` 기록(드롭 시 제거) |
| `WebDesktopMcpConfig::new(app_name, app_version).with_port(u16)` | 설정 |
| `init_script() -> String` | 부트스트랩 JS(수동 `initialization_script`용) |
| `endpoint() -> Option<(String, String)>` | `(url, token)` — 에이전트 연결 안내용 |
| `#[command] send(window, message)` | JS→호스트 채널 (`webdesktopmcp:allow-send` 권한 기본 부여) |

## 부트스트랩 JS 동작

공통 TypeScript 코어에서 생성한 스크립트를 주입합니다. 필요한 네이티브 메서드를 감지하면 설치 이후 `registerTool` 호출을 미러링하고, 그렇지 않으면 폴리필을 사용합니다. 폴리필은 선언형 `<form toolname>` 부분집합을 포함합니다. 네이티브 선언형 폼은 외부 MCP에 미러링하지 않습니다. 전체 브라우저 초안 적합성은 주장하지 않습니다.

## 연결

앱 실행 중 `~/.webdesktopmcp/registry.json`의 엔드포인트로:

```bash
webdesktopmcp connect --app "내 앱"   # stdio 셈 (Claude Desktop)
# 또는 HTTP 직접 연결 (URL + Bearer 토큰)
```

## 검증 범위 · 2026-09-05

`cargo check`, `cargo build`, `cargo test`로 현재 checkout을 검증하세요. 로컬 빌드·자동 테스트는 실제 네이티브 GUI 검증이나 공식 WPT 적합성 검증을 의미하지 않습니다. 기능별 범위와 제한은 [지원 표](../../docs/support.md), 신뢰 경계는 [보안 모델](../../docs/security.md)를 참고하세요.

호스트의 webview URL은 DOM 하위 iframe 신원을 인증하지 않습니다. 신뢰된 앱 콘텐츠에만 브리지를 설치하세요. 자동 주입보다 일찍 실행되는 도구 등록이 있다면 `initialization_script`를 사용하세요.
