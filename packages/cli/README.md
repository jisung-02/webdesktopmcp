# @webdesktopmcp/cli

실행 중인 webdesktopmcp 데스크톱 앱을 stdio MCP 클라이언트에 연결하는 셈.

```bash
# 실행 중인 앱 목록
webdesktopmcp list

# Claude Desktop 등 stdio 전용 클라이언트용
webdesktopmcp connect --app "내 앱" [--registry <dir>] [--wait <초>]
```

Claude Desktop 설정(`~/Library/Application Support/Claude/claude_desktop_config.json` 등):

```json
{
  "mcpServers": {
    "내 앱": {
      "command": "npx",
      "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "내 앱"]
    }
  }
}
```

동작: `~/.webdesktopmcp/registry.json`에서 앱을 찾아(pid 생존 확인) → 앱의 루프back Streamable-HTTP MCP 엔드포인트에 연결 → stdio로 `tools/list`, `tools/call`을 프록시. 앱이 종료되면 연결이 닫히고, 다시 켜면 클라이언트가 셈을 재시작하면 됩니다.
