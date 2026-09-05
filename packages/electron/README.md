# @webdesktopmcp/electron

Electron 앱의 페이지 도구를 MCP에 연결하는 실험적 어댑터. 자세한 사용법은 [루트 README](../../README.md)를 참고하세요.

## 특징

- **기능 감지로 네이티브 모드 선택**: Chromium 버전은 실험 플래그 요청의 기준일 뿐 API 제공 보장이 아닙니다. 페이지에서 필요한 메서드를 감지해 네이티브 등록 미러 또는 부분 폴리필을 사용합니다. 네이티브 선언형 도구는 외부에 미러링하지 않습니다. [지원 표](../../docs/support.md)를 참고하세요.
- **프리로드 자동 주입**: Electron ≥ 35의 `session.registerPreloadScript`로 모든 윈도우에 자동 적용(구버전은 `setPreloads` 폴백, 그래도 안 되면 `mcp.preloadPath`를 webPreferences에 수동 지정).
- **멱등**: 윈도우 레벨 + 세션 레벨 프리로드가 이중 실행돼도 안전(브리지/부트스트랩 가드).
- **확인 다이얼로그 훅**: `confirmToolCall`로 민감 도구 호출 전 네이티브 동의 절차.
- **앱 레지스트리**: `~/.webdesktopmcp/registry.json`에 엔드포인트·토큰 기록 → `webdesktopmcp connect --app` 이 자동 발견.

## API

```ts
installWebDesktopMcp(options: {
  appName: string;
  appVersion?: string;
  native?: "auto" | "off";          // 기본 "auto" (실행 시 기능 감지)
  blinkFeatureName?: string;        // 기본 "WebMCP" (업스트림 리네임 대비)
  port?: number;                    // 기본 에페멀럴
  confirmToolCall?: (tool, input) => boolean | Promise<boolean>;
  log?: (message: string) => void;
}): {
  preloadPath: string;
  ready: Promise<{ url: string; token: string; port: number }>;
  registry: ToolRegistry;
  dispose(): Promise<void>;
}

chromiumSupportsNativeWebMcp(chromeVersion?): boolean  // >= 149 버전 휴리스틱; 네이티브 API 존재 보장 아님
```

`app.whenReady()` **전에** 호출하세요(Chromium 스위치가 렌더러에 적용되려면).
