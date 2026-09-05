# webdesktopmcp

**Un puente experimental WebMCP-to-MCP para Electron · Tauri · Wails**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

Expone funciones de la página a agentes externos mediante un servidor MCP local y un enlace CLI stdio. El [borrador CG WebMCP del 4 de septiembre de 2026](https://webmachinelearning.github.io/webmcp/) no es un estándar W3C ni pertenece al W3C Standards Track. Esta biblioteca no afirma conformidad completa.

```ts
// Experimental WebMCP draft API
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

## Compatibilidad · 2026-09-05

El modo nativo se selecciona detectando los métodos necesarios de `document.modelContext` durante la ejecución. Una versión o una bandera no garantiza disponibilidad. [Electron 44 incluye Chromium 152](https://www.electronjs.org/blog/electron-44-0) y [Chrome ofrece un origin trial desde 149](https://developer.chrome.com/docs/ai/webmcp).

El modo polyfill de los tres adaptadores comparte implementación y un subconjunto de formularios declarativos. El espejo nativo solo observa llamadas imperativas a `registerTool` posteriores a su instalación. Los formularios declarativos nativos no se exponen a clientes MCP externos. Los modos no son idénticos.

La biblioteca no reproduce todo el aislamiento iframe/Permissions Policy ni prohíbe la ejecución headless. Las herramientas deben validar sus entradas: no hay validación JSON Schema en tiempo de ejecución. Un `exposedTo` no vacío bloquea el descubrimiento y las llamadas externas por política de la biblioteca.

## Paquetes

| Paquete | Lenguaje | Propósito |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | Protocolo de red compartido por los hosts TS/Rust/Go ([especificación](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | Polyfill de `document.modelContext` + espejo nativo + API declarativa de formularios |
| [`@webdesktopmcp/server`](packages/server) | TS | Servidor MCP local agnóstico del framework + registro de aplicaciones |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Adaptador Electron (inyección automática de preload, comdetección de funciones, hook de confirmación) |
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

En el renderer basta con usar el código `document.modelContext.registerTool` mostrado arriba. Para inferencia de tipos usa el helper `defineTool` de `@webdesktopmcp/core` (el tipo de la entrada se infiere dentro de `execute`). Al depurar, `window.__webDesktopMcp.listTools()` en la consola de DevTools muestra las herramientas registradas. También está soportada la **API declarativa de formularios** — un formulario se convierte en herramienta sin una sola línea de JavaScript:

```html
<!-- Polyfill mode: native declarative forms are not mirrored externally. -->
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

Ejemplo en modo polyfill: La app de demostración (`examples/electron-demo`) expone 4 herramientas imperativas más una herramienta declarativa de formulario (`order-coffee`). Desde Claude Desktop prueba *"muéstrame las tareas abiertas"* o *"pide un latte con 2 shots"*.

## Estado de verificación

Instalación, configuración de Tauri/Wails y CLI: [guía en inglés](README.md). La [matriz de compatibilidad](docs/support.md) define funciones y alcance de verificación; consulte también la [seguridad](docs/security.md). Las pruebas locales no acreditan conformidad con WPT oficiales ni validación de GUI nativas en todas las plataformas.

```bash
pnpm build
pnpm test
pnpm typecheck
```

## Relación con el borrador WebMCP

Expone funciones de la página a agentes externos mediante un servidor MCP local y un enlace CLI stdio. El [borrador CG WebMCP del 4 de septiembre de 2026](https://webmachinelearning.github.io/webmcp/) no es un estándar W3C ni pertenece al W3C Standards Track. Esta biblioteca no afirma conformidad completa.

[Support and verification](docs/support.md) · [Research notes](webmcp-research.md)

## Licencia

MIT

[References and implementation evidence](docs/references.md)
