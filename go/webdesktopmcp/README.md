# webdesktopmcp (Wails v2용 Go 패키지)

Wails v2 앱의 웹뷰를 WebMCP 서버로 만듭니다. 표준 라이브러리만 사용(wails 임포트 없음 — 바인딩은 아래 패턴으로 연결).

## 사용법

```go
// main.go
import "github.com/webdesktopmcp/go-webdesktopmcp"

func main() {
    mcp, err := webdesktopmcp.New(webdesktopmcp.Config{
        AppName:    "내 앱",
        AppVersion: "1.0.0",
    })
    if err != nil { panic(err) }
    defer mcp.Close()

    err = wails.Run(&options.App{
        // ...
        Bind: []interface{}{mcp},          // JS에서 window.go.webdesktopmcp.Server 로 접근
        OnStartup: func(ctx context.Context) {
            mcp.SetEventEmitter(func(event string, data ...interface{}) {
                runtime.EventsEmit(ctx, event, data...) // 호스트→JS 전달
            })
        },
        OnShutdown: func(_ context.Context) { _ = mcp.Close() },
        AssetServer: &assetserver.Options{
            Handler: mcp.Handler(), // GET /webdesktopmcp.js 서빙
        },
    })
}
```

```html
<!-- index.html — 가능한 한 앞쪽에서 (document 시작 시점 주입) -->
<script src="/webdesktopmcp.js"></script>
```

페이지 등록 API (실험적 CG 초안의 부분 구현): `document.modelContext.registerTool({ name, description, inputSchema, execute })`.

## 주요 API

| 멤버 | 용도 |
|---|---|
| `New(Config) (*Server, error)` | 서버 기동(127.0.0.1 바인딩) + 레지스트리 파일 기록 |
| `URL() / Token() / Port()` | 루프백 MCP 엔드포인트 정보 |
| `SetEventEmitter(func(event string, data ...interface{}))` | 호스트→JS 메시지 전달기 (`runtime.EventsEmit` 연결) |
| `Send(frameID string, message map[string]any)` | JS→호스트 (wails Bind용) |
| `SetConfirmHook(func(toolName string, input map[string]any) bool)` | 민감 도구 게이트 |
| `SetFrameOrigin(frameID, origin)` | 호스트가 신뢰한 origin 기록 (페이지 `_origin`은 인증 근거로 사용하지 않음) |
| `FrameGone(frameID)` | 창 닫힘 시 도구 정리 |
| `InitScript() / Handler()` | 부트스트랩 JS (`go:embed js/bootstrap.js`) |
| `Close() error` | 서버 종료 + 레지스트리 엔트리 제거 |

## 부트스트랩 JS 동작

공통 TypeScript 코어에서 생성한 스크립트를 주입합니다. 필요한 네이티브 메서드를 감지하면 설치 이후 `registerTool` 호출을 미러링하고, 그렇지 않으면 폴리필을 사용합니다. 폴리필은 선언형 `<form toolname>` 부분집합을 포함합니다. 네이티브 선언형 폼은 외부 MCP에 미러링하지 않습니다. 전체 브라우저 초안 적합성은 주장하지 않습니다.

## 연결

앱 실행 중 `~/.webdesktopmcp/registry.json`의 엔드포인트로 접속:

```bash
webdesktopmcp connect --app "내 앱"     # stdio 셈 (Claude Desktop)
# 또는 HTTP 직접 연결: URL + Bearer 토큰(registry.json 참조)
```

## 검증 범위 · 2026-09-05

`go build ./...`, `go vet ./...`, `go test -race -count=1 ./...`로 현재 checkout을 검증하세요. 로컬 빌드·자동 테스트는 실제 네이티브 GUI 검증이나 공식 WPT 적합성 검증을 의미하지 않습니다. 기능별 범위와 제한은 [지원 표](../../docs/support.md), 신뢰 경계는 [보안 모델](../../docs/security.md)를 참고하세요.

`Send(frameID, message)`는 신뢰된 앱 renderer를 전제합니다. frameID는 플랫폼이 인증한 DOM 프레임 신원이 아닙니다. 교차 프레임 origin은 호스트에서 `SetFrameOrigin`으로 설정하세요.
