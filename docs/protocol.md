# webdesktopmcp 와이어 프로토콜 (v1)

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
| `executeForward` | `requestId`, `name`, `input`, `fromOrigin` | 인페이지 에이전트가 다른 프레임의 도구 호출. 호스트는 `executeForwardResult`로 응답. |
| `getToolsRequest` | `requestId`, `fromOrigins?`, `forOrigin` | 크로스 프레임 도구 목록. 호스트는 `getToolsResponse`로 응답. |
| `toolRemoved` | `name`, `frameId` | (예약) 프레임 소멸 통지. 현재 호스트가 프레임 소멸을 직접 감지. |
| `log` | `level`, `message` | 디버그 로그 (호스트 콘솔로 릴레이). |

### ToolDeclaration

```ts
{
  name: string;          // 필수. 1–128자, [A-Za-z0-9_.-] (W3C 문법)
  title?: string;        // UI 표시용
  description: string;   // 필수, 비어있으면 안 됨
  inputSchema?: { type: string, properties?: object, required?: string[], ... };  // JSON Schema
  annotations?: { readOnlyHint?: boolean, untrustedContentHint?: boolean };
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
2. **origin 스탬프**: `register` 수신 시 해당 웹뷰의 origin(`http://localhost:3000`, `file://...`, `tauri://localhost` 등)을 기록.
3. **이름 유니크 강제**: 앱 전체에서 도구 이름 유니크. 중복 시 해당 프레임에 `ok:false` + 이유.
4. **MCP 노출**: 레지스트리의 도구를 Streamable-HTTP MCP 서버로 노출.
   - 바인딩: `127.0.0.1` 전용, Bearer 토큰 필수, `GET /mcp?health=1`은 무인증 헬스체크.
   - `tools/list`: `exposedTo`가 설정된 도구는 외부 클라이언트에 숨김 (인페이지 에이전트 전용).
   - `tools/call`: 소유 프레임에 `execute` 전송 → `executeResult` 대기 → 결과(JSON 문자열)를 text content로 반환. 타임아웃 권장: 120초.
   - `abort`: MCP 클라이언트 취소 시 프레임에 `abort` 전송.
5. **프레임 소멸**: 웹뷰 종료 시 그 프레임의 도구를 모두 제거.
6. **확인 다이얼로그 훅**: `tools/call` 전에 네이티브 confirm 콜백 호출 기회 제공 (민감 작업 보호).
7. **앱 레지스트리 파일**: `~/.webdesktopmcp/registry.json` (mode 0600, 원자적 쓰기):

```json
{ "apps": { "MyApp": {
    "appName": "MyApp", "url": "http://127.0.0.1:54321/mcp",
    "token": "...", "pid": 1234, "protocolVersion": 1,
    "updatedAt": "2026-09-03T12:00:00.000Z" } } }
```

8. **부트스트랩 선택**: 페이지 부츠 시 `"modelContext" in document`면 네이티브 미러(`@webdesktopmcp/core`의 `installNativeModelContextMirror`와 동일 동작: registerTool 래핑 → 호스트로 미러링, 외부 호출은 캡처한 execute로 라우팅), 아니면 폴리필 설치.

## 폴리필 시맨틱 (core 구현 기준)

- `registerTool` 검증 실패(name 문법/빈 description/execute 누락): 즉시 `InvalidStateError`류 예외.
- 등록은 낙관적: 호스트 `registerResult(ok:false)` 수신 시 로컬 롤백.
- `AbortSignal` 옵션: in-flight 중 abort → reject+롤백, 등록 후 abort → unregister 전송 (W3C 동작).
- 실행 결과는 JSON 문자열화. 직렬화 불가 시 `ExecutionError`.
- `getTools`/`executeTool`은 인페이지 에이전트(다른 프레임)용 원격 서피스.
