const { app, BrowserWindow, dialog } = require("electron");
const { installWebDesktopMcp, chromiumSupportsNativeWebMcp } = require("@webdesktopmcp/electron");

// Must run before app.whenReady() so Chromium switches take effect.
const mcp = installWebDesktopMcp({
  appName: "WebDesktopMCP Demo",
  appVersion: "0.1.0",
  // 민감하지 않은(읽기 전용) 도구는 바로 통과, 나머지는 네이티브 확인 다이얼로그.
  confirmToolCall: async (tool, input) => {
    if (tool.annotations?.readOnlyHint) return true;
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["허용", "거부"],
      defaultId: 1,
      title: "webdesktopmcp",
      message: `에이전트가 "${tool.name}" 도구를 호출하려 합니다`,
      detail: JSON.stringify(input, null, 2),
    });
    return response === 0;
  },
});

console.log(
  `[demo] Chromium ${process.versions.chrome} — native WebMCP: ${
    chromiumSupportsNativeWebMcp() ? "YES (mirror mode)" : "no (polyfill mode)"
  }`,
);

async function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    webPreferences: {
      preload: mcp.preloadPath,
    },
  });
  await win.loadFile("index.html");
}

app.whenReady().then(async () => {
  const { url, port } = await mcp.ready;
  console.log(`[demo] 로컬 MCP 서버: ${url}  (Claude Desktop: npx @webdesktopmcp/cli connect --app "WebDesktopMCP Demo")`);
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
