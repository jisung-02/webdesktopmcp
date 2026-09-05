# webdesktopmcp 와이어 프로토콜 (v1)

공식 출처와 구현·테스트별 적용 근거: [레퍼런스](references.md).

웹뷰(페이지)와 네이티브 호스트(Electron main / Tauri Rust / Wails Go) 사이의 메시지 계약.
참조 구현: `packages/protocol/src/index.ts` (TS), `packages/core` (폴리필).

## 브리지 (window 전역)

호스트 어댑터는 페이지의 **메인 월드**에 `window.__webDesktopMcpHost`를 노출해야 한다:

```ts
interface HostBridge {
  send(message: RendererMessage): void;            // 페이지 → 호스트
  onMessage(handler: (m: HostMessage) => void): () => void;  // 구독, 해제 함수 반환
}
```

메시지는 JSON 직렬화 가능한 객체여야 한다 (IPC structured clone / JSON 어느 쪽이든 안전).

## 메시지: 페이지 → 호스트 (RendererMessage)

| kind | 필드 | 의미 |
|---|---|---|
| `register` | `invocationId`, `tool: ToolDeclaration`, `exposedTo?: string[]` | 도구 등록. 호스트는 반드시 `registerResult`로 응답. |
| `unregister` | `invocationId`, `name` | 도구 해제. 응답 없음. |
| `executeResult` | `invocationId`, `ok`, `result?`(JSON 문자열), `errorCode?`, `errorMessage?` | 호스트가 요청한 실행의 결과. |
| `executeForward` | `requestId`, `name`, `input`, `fromOrigin`(레거시 힌트) | 같은 프레임 또는 허용된 다른 웹뷰의 도구 호출. 호스트는 `executeForwardResult`로 응답. |
| `cancelForward` | `requestId` | 호출자 프레임에 속한 전달 호출만 취소. 소유 프레임에 `abort` 전송. |
| `getToolsRequest` | `requestId`, `fromOrigins?`, `forOrigin`(레거시 힌트) | 크로스 프레임 도구 목록. 호스트는 `getToolsResponse`로 응답. |
| `toolRemoved` | `name`, `frameId` | (예약) 프레임 소멸 통지. 현재 호스트가 프레임 소멸을 직접 감지. |
| `log` | `level`, `message` | 디버그 로그 (호스트 콘솔로 릴레이). |

### ToolDeclaration

```ts
{
  name: string;          // 필수. 1–128자, [A-Za-z0-9_.-] (W3C 문법)
  title?: string;        // UI 표시용
  description: string;   // 필수, 비어있으면 안 됨
  inputSchema?: { type: string, properties?: object, required?: string[], ... };  // JSON Schema
  annotations?: { readOnlyHint?: boolean, untrustedContentHint?: boolean, consequentialHint?: boolean };
}
```

## 메시지: 호스트 → 페이지 (HostMessage)

| kind | 필드 | 의미 |
|---|---|---|
| `execute` | `invocationId`, `name`, `input` | 도구 실행 요청. 페이지는 `executeResult`로 응답 의무. `invocationId`는 호스트가 유니크하게 부여. |
| `abort` | `invocationId` | 진행 중 실행 취소 (에이전트 취소 전파). |
| `registerResult` | `invocationId`, `ok`, `errorMessage?` | 등록 결과. `ok:false`면 페이지는 낙관적 등록을 롤백해야 함. |
| `toolsChanged` | `tools: RegisteredToolInfo[]` | (옵션) 크로스 프레임 도구 스냅샷 변경. |
| `getToolsResponse` | `requestId`, `tools: RegisteredToolInfo[]` | `getToolsRequest` 응답. |
| `executeForwardResult` | `requestId`, `ok`, `result?`, `errorCode?`, `errorMessage?` | `executeForward` 응답. |
| `init` | (예약) `protocolVersion`, `appName`, `frameId`, ... | v1에서는 미사용. |

### RegisteredToolInfo

```ts
ToolDeclaration & { origin: string, frameId: string, exposedTo?: string[] }
```

## 호스트 의무 사항

1. **frameId**: 웹뷰별 고유 라벨 (Electron: `webContents.id` 문자열, Tauri: webview label, Wails: 창 이름).
2. **출처와 소유권**: Electron/Tauri는 IPC가 식별한 최상위 웹뷰 URL에서 출처를 구한다. Wails는 신뢰하는 호스트의 `SetFrameOrigin`을 사용한다. 페이지가 보낸 `fromOrigin`, `forOrigin`, `_origin`은 권한 판단에 사용하지 않는다. `executeResult`는 진행 중 호출의 소유 프레임이 보낸 것만 수락한다. Wails 바인딩은 신뢰하는 앱 페이지 전용이며, 프레임 ID 인증을 제공하지 않는다.
3. **이름 유니크 강제**: 앱 전체에서 도구 이름 유니크. **다른 프레임**이 같은 이름 등록 시 `ok:false` + 이유. **같은 프레임**의 재등록(리로드·속성 갱신)은 기존 항목을 교체한다 — 페이지가 문서 아래에서 바뀌었는데 도구가 남아있으면 안 된다.
4. **MCP 노출**: 레지스트리의 도구를 Streamable-HTTP MCP 서버로 노출.
   - 바인딩: `127.0.0.1` 전용, Bearer 토큰 필수, `GET /mcp?health=1`은 무인증 헬스체크.
   - `tools/list`: `exposedTo`가 설정된 도구는 외부 클라이언트에 숨김 (인페이지 에이전트 전용).
   - `tools/call`: **`exposedTo` 도구는 이름으로 직접 호출해도 게이트에서 거부**한다(웹뷰로 라우팅 금지). 이후 소유 프레임에 `execute` 전송 → `executeResult` 대기 → 결과(JSON 문자열)를 text content로 반환. 타임아웃 권장: 120초.
   - 취소: 페이지 `cancelForward`와 호스트 타임아웃은 소유 프레임으로 `abort`를 전달한다. CLI는 호출별 HTTP 연결을 취소 시 닫는다. 연결 종료 감지는 호스트 구현에 따라 다르며, 세션 없는 HTTP의 별도 `notifications/cancelled` 요청은 다른 요청의 호출과 연결하지 않는다.
   - `structuredContent`: 결과가 JSON 객체인 경우만 포함. 배열·원시값은 text content에만 포함. 브라우저 전용 annotations는 `_meta["webdesktopmcp/annotations"]`로 보존.
5. **프레임 소멸**: 웹뷰 종료·문서 교체 시 도구를 제거하고, 관련 대기 호출을 정리한다. 호출자 종료 시 원격 실행에도 취소를 보낸다. Wails의 `_session`은 페이지 재로드를 식별하며 인증 토큰이 아니다.
6. **확인 훅**: Electron/Go는 외부 `tools/call` 전 확인 훅을 제공한다. Tauri에서는 도구 구현 또는 앱 호스트에서 확인을 구현한다.
7. **앱 레지스트리 파일**: `~/.webdesktopmcp/registry.json` (mode 0600, 원자적 쓰기):

```json
{ "apps": { "MyApp": {
    "appName": "MyApp", "url": "http://127.0.0.1:54321/mcp",
    "token": "...", "pid": 1234, "protocolVersion": 1,
    "updatedAt": "2026-09-03T12:00:00.000Z" } } }
```

8. **부트스트랩 선택**: 런타임 `document.modelContext.registerTool`을 확인한 뒤 네이티브 미러 또는 폴리필을 선택한다. 버전 숫자는 기능 보장이 아니다. 네이티브 등록 성공 뒤 호스트에 등록하고, 호스트 거부 시 내부 등록 신호를 취소해 롤백한다. 등록 옵션의 `exposedTo`·`signal`·도구 메타데이터를 보존한다. 네이티브 선언형 폼과 미러 설치 전 등록은 외부에 미러링하지 않는다.
9. **페이지 접근**: 같은 프레임은 자신의 도구를 실행할 수 있다. 다른 웹뷰는 동일 출처 또는 명시적인 `exposedTo` 허용이 필요하다. `fromOrigins`는 동일 출처 외에 조회할 출처를 추가한다. 동일 출처 도구는 항상 포함하고, 다른 출처 도구는 요청 목록과 노출 권한을 모두 확인한다. 외부 MCP에서 비어 있지 않은 `exposedTo` 도구를 숨기는 것은 별도의 라이브러리 정책이다.
10. **Wails 수신 대상**: 이벤트가 모든 창에 방송되므로 호스트 메시지의 `_frameId`가 자신의 창 이름과 일치할 때만 전달한다. 직접 바인딩은 신뢰하는 렌더러를 전제한다.

페이지 코드는 `packages/core`에서 공유한다. Tauri/Wails용 스크립트는 `pnpm build:native`로 생성하고 `pnpm check:generated`로 갱신 누락을 검사한다. 바이너리 소비자는 포함된 스크립트를 사용하므로 Node 빌드를 추가로 실행하지 않아도 된다. v1의 `cancelForward` 확장이 필요하므로 호스트와 페이지 번들은 함께 업데이트해야 한다. 버전 협상이나 오래된 호스트에서의 취소 호환성은 제공하지 않는다.

## 폴리필 시맨틱 (core 구현 기준)

- `registerTool` 검증 실패(name 문법/빈 description/execute 누락): 즉시 `InvalidStateError`류 예외.
- 등록은 낙관적: 호스트 `registerResult(ok:false)` 수신 시 로컬 롤백.
- `AbortSignal` 옵션: in-flight 중 abort → reject+롤백, 등록 후 abort → unregister 전송 (W3C 동작).
- 실행 결과는 JSON 문자열화. 직렬화 불가 시 `ExecutionError`.
- `getTools`/`executeTool`은 자신의 프레임 및 허용된 웹뷰용 서피스다. 브라우저의 전체 문서 트리·Permissions Policy·WPT 호환성은 구현하지 않는다.
