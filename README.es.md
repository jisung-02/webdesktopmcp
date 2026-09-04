# webdesktopmcp

**Convierte aplicaciones de escritorio (Electron · Tauri · Wails) en servidores WebMCP.**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | Español

Con unas pocas líneas de código, los desarrolladores de apps de escritorio exponen las funcionalidades de su aplicación como **herramientas para agentes de IA** (Claude Desktop, Claude Code, Cursor, ChatGPT Desktop…). El código de la página usa tal cual la API estándar del [borrador W3C WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`) — y la librería cambia automáticamente a la API nativa real en cuanto el runtime la incluya.

```ts
// Código de la app — la API estándar de W3C WebMCP, sin cambios
document.modelContext.registerTool({
  name: "search-orders",
  description: "Buscar pedidos por número de pedido o nombre del cliente",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Número de pedido o nombre del cliente" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query }, { signal }) => searchOrders(query, signal),
});
```

```jsonc
// Configuración de Claude Desktop — con la app en ejecución, los agentes pueden llamar a estas herramientas
{ "mcpServers": { "MyApp": {
    "command": "npx", "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }
```

## Cómo funciona

Los webviews de escritorio todavía no incluyen la API WebMCP nativa (el Chromium de Electron está por debajo de la 149; Tauri usa WKWebView/WebView2), así que la librería puentea tres capas:

```
[Página dentro del webview]
  document.modelContext.registerTool(...)     ← polyfill o espejo nativo (la misma API)
        │  IPC — protocolo de red en docs/protocol.md
        ▼
[Host nativo]  Electron main / Tauri (Rust) / Wails (Go)
  Registro de herramientas + servidor MCP local (127.0.0.1, token bearer)
        │
        ├─ Streamable HTTP  ← Cursor, Claude Code, … conexión directa
        └─ @webdesktopmcp/cli (shim stdio) ← Claude Desktop, …
```

**Compuerta por versión con prioridad nativa** — el adaptador de Electron comprueba `process.versions.chrome`:

- **Chromium ≥ 149** → habilita WebMCP nativo mediante el interruptor `--enable-blink-features=WebMCP`. La página usa el **`document.modelContext` nativo real**; el adaptador solo envuelve `registerTool` de forma transparente para reflejar los registros hacia agentes externos (los agentes integrados del navegador siguen usando la ruta nativa).
- **Inferior a 149** (todas hoy en día) → inyecta un polyfill con la semántica del W3C. El cambio es automático, sin modificar el código de la app.

## Paquetes

| Paquete | Lenguaje | Propósito |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | Protocolo de red compartido por los hosts TS/Rust/Go ([especificación](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | Polyfill de `document.modelContext` + espejo nativo + API declarativa de formularios |
| [`@webdesktopmcp/server`](packages/server) | TS | Servidor MCP local agnóstico del framework + registro de aplicaciones |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Adaptador Electron (inyección automática de preload, compuerta de versión, hook de confirmación) |
| [`@webdesktopmcp/cli`](packages/cli) | TS | Shim stdio `webdesktopmcp connect --app <nombre>` |
| `crates/tauri-plugin-webdesktopmcp` | Rust | Plugin de Tauri v2 |
| `go/webdesktopmcp` | Go | Paquete para Wails v2 |

## Inicio rápido con Electron

```bash
npm i @webdesktopmcp/electron
```

```js
// main.js — antes de app.whenReady()
const { installWebDesktopMcp } = require("@webdesktopmcp/electron");
const mcp = installWebDesktopMcp({
  appName: "MyApp",
  appVersion: "1.0.0",
  // Protege herramientas sensibles con un diálogo nativo de confirmación (opcional)
  confirmToolCall: async (tool, input) => { /* dialog… */ return true; },
});

const win = new BrowserWindow({
  webPreferences: { preload: mcp.preloadPath },  // recomendado (también existe registro automático a nivel de sesión)
});
```

En el renderer basta con usar el código estándar `document.modelContext.registerTool` mostrado arriba. Para inferencia de tipos usa el helper `defineTool` de `@webdesktopmcp/core` (el tipo de la entrada se infiere dentro de `execute`). Al depurar, `window.__webDesktopMcp.listTools()` en la consola de DevTools muestra las herramientas registradas. También está soportada la **API declarativa de formularios** — un formulario se convierte en herramienta sin una sola línea de JavaScript:

```html
<form toolname="order-coffee"
      tooldescription="Pedir un café. Recibe el tipo de bebida y el número de shots, devuelve un número de pedido."
      toolautosubmit>
  <select name="drink" toolparamdescription="Tipo de bebida">
    <option value="americano">americano</option>
    <option value="latte">latte</option>
  </select>
  <input type="number" name="shots" toolparamdescription="Número de shots" value="1" />
  <button type="submit">Pedir</button>
</form>
```

Llama a `event.respondWith(result)` en el manejador submit del formulario y ese valor se devuelve al agente (`event.agentInvoked` indica que fue el agente quien envió el formulario — el `SubmitEvent#respondWith` del borrador, polillerizado).

## Tauri (v2) / Wails (v2)

```rust
// Tauri — Rust
tauri::Builder::default()
    .plugin(tauri_plugin_webdesktopmcp::init(
        tauri_plugin_webdesktopmcp::WebDesktopMcpConfig::new("MyApp", "1.0.0"),
    ))
```

```go
// Wails — Go
mcp, _ := webdesktopmcp.New(webdesktopmcp.Config{AppName: "MyApp", AppVersion: "1.0.0"})
mcp.SetEventEmitter(func(event string, data ...interface{}) { runtime.EventsEmit(ctx, event, data...) })
// añade mcp a options.Bind + inyecta mcp.InitScript() en index.html
```

Consulta el README de cada directorio para más detalles.

## Conectar agentes

```bash
# Listar aplicaciones en ejecución
npx @webdesktopmcp/cli list

# Ver las herramientas de una app en ejecución
npx @webdesktopmcp/cli tools --app "MyApp"

# Claude Desktop (stdio) — claude_desktop_config.json:
{ "mcpServers": { "MyApp": { "command": "npx",
    "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }

# Clientes con soporte HTTP (Cursor, Claude Code, …) — usa lo que la app imprime:
#   URL:    http://127.0.0.1:<puerto>/mcp
#   Token:  apps["MyApp"].token en ~/.webdesktopmcp/registry.json
```

El endpoint solo se enlaza a `127.0.0.1` y requiere un token bearer. Modelo de seguridad: [docs/security.md](docs/security.md).

## Demo

```bash
pnpm install
pnpm --filter webdesktopmcp-electron-demo start
# en otra terminal, mientras la app está en ejecución:
node packages/cli/dist/cli.js list
```

La app de demostración (`examples/electron-demo`) expone 4 herramientas imperativas más una herramienta declarativa de formulario (`order-coffee`). Desde Claude Desktop prueba *"muéstrame las tareas abiertas"* o *"pide un latte con 2 shots"*.

## Estado de verificación

- `@webdesktopmcp/core` — vitest **19/19** (semántica del polyfill, formularios declarativos, espejo nativo)
- `@webdesktopmcp/server` — vitest **9/9** (registro, initialize/list/call MCP por HTTP, autenticación, filtro de exposición, hook de confirmación)
- Demo Electron — **verificada de extremo a extremo en una app real**: arranque → inyección de preload → 5 herramientas registradas → `tools/call` por HTTP para herramientas imperativas y declarativas → también invocadas a través del shim stdio de la CLI
- Tauri (Rust) / Wails (Go) — verificados con `cargo check`/`go build` y sus suites de pruebas (ver el README de cada directorio)

## Relación con el estándar WebMCP

Esta librería lleva la API del lado de la página del [borrador W3C WebMCP CG](https://webmachinelearning.github.io/webmcp/) ([repo](https://github.com/webmachinelearning/webmcp); prueba de origen en Chrome 149 / Edge 150) a los webviews de escritorio. La prueba de concepto original es [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP); el ecosistema de herramientas está en MCP-B ([sitio](https://mcp-b.ai)). La investigación técnica completa (en coreano): [webmcp-research.md](webmcp-research.md).

## Licencia

MIT
