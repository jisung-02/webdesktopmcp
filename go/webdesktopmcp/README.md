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
        OnStartup: func(ctx context.Context, _ options.App) error {
            mcp.SetEventEmitter(func(event string, data ...interface{}) {
                runtime.EventsEmit(ctx, event, data...) // 호스트→JS 전달
            })
            return nil
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

페이지 코드는 표준 WebMCP API 그대로: `document.modelContext.registerTool({ name, description, inputSchema, execute })`.

## 주요 API

| 멤버 | 용도 |
|---|---|
| `New(Config) (*Server, error)` | 서버 기동(127.0.0.1 바인딩) + 레지스트리 파일 기록 |
| `URL() / Token() / Port()` | 루프백 MCP 엔드포인트 정보 |
| `SetEventEmitter(func(event string, data ...interface{}))` | 호스트→JS 메시지 전달기 (`runtime.EventsEmit` 연결) |
| `Send(frameID string, message map[string]any)` | JS→호스트 (wails Bind용) |
| `SetConfirmHook(func(toolName string, input map[string]any) bool)` | 민감 도구 게이트 |
| `SetFrameOrigin(frameID, origin)` | 프레임 origin 기록 (JS가 `_origin`으로도 전송) |
| `FrameGone(frameID)` | 창 닫힘 시 도구 정리 |
| `InitScript() / Handler()` | 부트스트랩 JS (`go:embed js/bootstrap.js`) |
| `Close() error` | 서버 종료 + 레지스트리 엔트리 제거 |

## 부트스트랩 JS 동작

`window.__webDesktopMcpHost {send, _deliver}`를 메인 월드에 정의하고, 네이티브 `document.modelContext`가 있으면 **미러 모드**(registerTool 래핑 → 호스트로 중계, 외부 호출은 캡처한 execute로 라우팅), 없으면 **폴리필 모드**(registerTool/unregisterTool/getTools/executeTool/ontoolchange, AbortSignal 수명 시맨틱)로 동작합니다. 선언형 `<form toolname>` API는 TS 코어(`@webdesktopmcp/core`)에만 구현되어 있습니다.

## 연결

앱 실행 중 `~/.webdesktopmcp/registry.json`의 엔드포인트로 접속:

```bash
webdesktopmcp connect --app "내 앱"     # stdio 셈 (Claude Desktop)
# 또는 HTTP 직접 연결: URL + Bearer 토큰(registry.json 참조)
```

## 검증

- `go build ./...`, `go vet ./...` 통과
- `go test -race -count=1 ./...` — 22개 테스트(레지스트리, MCP HTTP 왕복, 인증, 확인 훅, 레지스트리 파일, 부트스트랩 JS 스모크) 통과
