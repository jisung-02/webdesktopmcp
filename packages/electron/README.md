# @webdesktopmcp/electron

Electron 앱을 WebMCP 서버로 만드는 어댑터. 자세한 사용법은 [루트 README](../../README.md)를 참고하세요.

## 특징

- **버전 게이트 네이티브 전환**: `process.versions.chrome >= 149`면 `--enable-blink-features=WebMCP`로 네이티브 API를 켜고 페이지가 진짜 `document.modelContext`를 쓰게 합니다(등록만 외부로 미러링). 미만이면 W3C 시맨틱 폴리필을 주입합니다. 전환은 페이지 코드 변경 없이 자동.
- **프리로드 자동 주입**: Electron ≥ 35의 `session.registerPreloadScript`로 모든 윈도우에 자동 적용(구버전은 `setPreloads` 폴백, 그래도 안 되면 `mcp.preloadPath`를 webPreferences에 수동 지정).
- **멱등**: 윈도우 레벨 + 세션 레벨 프리로드가 이중 실행돼도 안전(브리지/부트스트랩 가드).
- **확인 다이얼로그 훅**: `confirmToolCall`로 민감 도구 호출 전 네이티브 동의 절차.
- **앱 레지스트리**: `~/.webdesktopmcp/registry.json`에 엔드포인트·토큰 기록 → `webdesktopmcp connect --app` 이 자동 발견.

## API

```ts
installWebDesktopMcp(options: {
  appName: string;
  appVersion?: string;
  native?: "auto" | "off";          // 기본 "auto" (버전 게이트)
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

chromiumSupportsNativeWebMcp(chromeVersion?): boolean  // >= 149
```

`app.whenReady()` **전에** 호출하세요(Chromium 스위치가 렌더러에 적용되려면).
