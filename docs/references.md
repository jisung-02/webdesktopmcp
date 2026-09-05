# 레퍼런스와 적용 근거

확인일: **2026-09-05**. 아래는 이번 현황 갱신과 수정에 사용한 1차 자료입니다. WebMCP는 2026-09-04 CG 초안, MCP는 명시된 2025-06-18 판을 참조합니다. 날짜가 고정되지 않은 공식 문서는 이후 변경될 수 있습니다. 링크가 있다는 사실만으로 이 프로젝트의 적합성이나 실제 런타임 지원이 입증되지는 않습니다. 현재 구현·검증 범위는 [지원 표](support.md)를 기준으로 합니다.

## WebMCP 사양과 브라우저 구현

| 공식 출처 | 확인한 내용과 프로젝트 적용 |
|---|---|
| [WebMCP CG 초안](https://webmachinelearning.github.io/webmcp/) — Status, §4.1–4.2 | W3C 표준이나 Standards Track 문서가 아님. `document.modelContext`와 비동기 등록 계약을 기준으로 README와 API 설명을 갱신. |
| [WebMCP CG 초안](https://webmachinelearning.github.io/webmcp/) — §4.2 등록·조회·실행 알고리즘 | 등록 `signal`과 실행 `signal`의 역할을 구분. `getTools({ fromOrigins })`는 same-origin 결과에 허용된 외부 origin을 추가하며, 외부 도구는 `exposedTo`도 충족해야 함. |
| [WebMCP CG 초안](https://webmachinelearning.github.io/webmcp/) — §4.2.6, §4.3, §4.5 | 네이티브 `RegisteredTool.window`, 선언형 도구, Permissions Policy의 기준. 프로젝트의 `frameId`, 폼 부분 구현, 데스크톱 신뢰 경계와 차이를 명시. |
| [Chrome WebMCP 개요](https://developer.chrome.com/docs/ai/webmcp) | Chrome 149부터 origin trial 안내. 버전만으로 네이티브 API 사용 가능 여부를 단정하지 않고 실제 문서에서 기능 탐지. |
| [Chrome Imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) | `AbortSignal`을 통한 등록 해제와 실행 취소, same-origin에 외부 origin을 추가하는 조회 예시. React 정리 로직과 native mirror 수명주기의 근거. |
| [Electron 44 릴리스](https://www.electronjs.org/blog/electron-44-0) | 2026-08-25 릴리스, Chromium 152 포함. 모든 Electron이 Chromium 149 미만이라는 기존 설명 수정. 이 버전 정보는 네이티브 WebMCP 실측 결과가 아님. |

## MCP와 호스트 런타임

| 공식 출처 | 확인한 내용과 프로젝트 적용 |
|---|---|
| [MCP Cancellation — 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation) | 요청 ID를 지정하는 선택적 취소 알림과 완료/취소 경합 처리. 별도 HTTP 요청의 취소 알림을 활성 호출과 연결하지 못하는 현재 제한을 명시. CLI의 호출별 연결 종료는 프로젝트 구현 선택이며 MCP 취소 알림과 동일한 기능이 아님. |
| [MCP Tools — 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | `structuredContent`는 JSON 객체. 객체 결과만 이 필드에 넣고 텍스트 결과도 유지. WebMCP 고유 annotation 보존 위치는 아래 프로젝트 정책 참고. |
| [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) — “Validate the sender of all IPC messages” | IPC 발신자를 검증하고 `senderFrame` URL을 확인하는 지침. 페이지가 전달한 origin 대신 호스트가 확인한 origin을 사용하고 main frame만 수락. |
| [Tauri 2.11.5 Manager](https://docs.rs/tauri/2.11.5/tauri/trait.Manager.html) | `get_webview_window`의 WebviewWindow 조회 계약. 현재 어댑터는 이 범위만 지원하며 일반 window의 child webview는 거부. 이는 전체 Tauri의 기능 제한이 아니라 현재 어댑터의 지원 범위. |
| [Wails v2 바인딩 구조](https://wails.io/docs/howdoesitwork/) · [런타임 Events](https://wails.io/docs/reference/runtime/events/) | 프런트엔드에서 Go 메서드를 호출하는 바인딩과 이벤트 전달 방식. 문자열 `frameId`의 인증 문제는 이 프로젝트의 `Send` 계약을 검토한 결과이며, 공식 문서가 프레임 신원 인증을 보장한다는 뜻이 아님. |
| [React useEffect](https://react.dev/reference/react/useEffect) | 의존성 변경·언마운트 시 cleanup, Strict Mode의 추가 setup/cleanup 주기. 등록별 AbortController로 정리하고 네이티브 `unregisterTool` 존재를 가정하지 않음. |
| [Node.js timingSafeEqual](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b) | 같은 바이트 길이를 요구하는 비교 API. 토큰 비교에 사용하며 주변 코드까지 상수시간이라는 보장은 하지 않음. |

## 프로젝트 자체 정책과 회귀 검증

아래 정책은 브라우저 사양이 요구한 동작과 구분합니다. 구현 링크는 현재 체크아웃을 가리키며, 테스트 링크는 해당 동작의 회귀 검증 위치입니다.

| 수정·정책 | 구현 | 검증 근거 |
|---|---|---|
| 네이티브 등록 성공 이후 외부 등록, 호스트 거부 시 롤백, 등록 신호·노출 조건 보존 | [native mirror](../packages/core/src/native-mirror.ts) | [native mirror 테스트](../packages/core/test/native-mirror.test.ts) |
| same-origin/외부 origin 접근 조건, 자체 페이지 실행, 선행 취소와 dispose 정리 | [polyfill](../packages/core/src/polyfill.ts) | [polyfill 테스트](../packages/core/test/polyfill.test.ts) |
| 비어 있지 않은 `exposedTo` 도구를 외부 MCP 조회·호출에서 제외; WebMCP annotation을 `_meta["webdesktopmcp/annotations"]`에 보존 | [서버](../packages/server/src/server.ts), [레지스트리](../packages/server/src/registry.ts) | [서버 테스트](../packages/server/test/server.test.ts) |
| IPC 발신자·실행 결과 소유권 확인, 네이티브 모드 설정 전달 | [Electron 호스트](../packages/electron/src/index.ts), [preload](../packages/electron/src/preload.ts) | [어댑터 테스트](../packages/electron/test/adapter.test.mjs), [실제 Electron smoke](../packages/electron/test/smoke.cjs) |
| Tauri/Wails가 폼 처리를 포함한 공통 TS 코어 사용; 생성 번들 최신성 확인 | [공통 어댑터](../packages/core/src/adapters/embedded.ts), [번들 생성기](../packages/electron/build-native.mjs) | [어댑터 테스트](../packages/core/test/adapters.test.ts), `pnpm check:generated` |
| Tauri 호출 웹뷰 확인 및 호스트 라우팅 | [commands](../crates/tauri-plugin-webdesktopmcp/src/commands.rs), [registry](../crates/tauri-plugin-webdesktopmcp/src/registry.rs) | Rust 모듈 내 단위 테스트, [HTTP 통합 테스트](../crates/tauri-plugin-webdesktopmcp/tests/http_smoke.rs) |
| Wails의 호스트 origin 설정, 신뢰된 renderer 전제, 세션·프레임별 전달 | [Go 호스트](../go/webdesktopmcp/server.go), [레지스트리](../go/webdesktopmcp/registry.go) | [호스트 테스트](../go/webdesktopmcp/server_test.go), [레지스트리 테스트](../go/webdesktopmcp/registry_test.go) |
| React 등록별 cleanup | [useMcpTool](../packages/react/src/use-mcp-tool.ts) | [React 테스트](../packages/react/test/use-mcp-tool.test.tsx) |
| CLI 취소가 다른 호출에 영향을 주지 않도록 호출별 HTTP 연결 사용 | [CLI](../packages/cli/src/cli.ts) | [취소 통합 테스트](../packages/cli/test/cancellation.test.mjs) |

`unregisterTool`, `getTools`의 `signal`, `frameId`, `cancelForward`는 라이브러리 확장입니다. 앱 전역 도구 이름, 외부 MCP 노출 제한, native mirror의 외부 등록 롤백도 프로젝트 설계입니다. 전체 메시지 계약은 [프로토콜](protocol.md), 인증과 플랫폼별 제한은 [보안 모델](security.md)에 기록합니다.

실제 Electron 실행 버전·모드·검증 항목은 [기록된 통합 실행](support.md#recorded-electron-integration-run)을 참조하세요. mock 기반 테스트는 네이티브 브라우저 구현의 증거가 아니며, 공식 WPT 적합성과 전체 플랫폼 GUI 검증은 수행했다고 주장하지 않습니다. 생태계·역사 자료는 [리서치 문서](../webmcp-research.md)에 별도로 유지합니다.
