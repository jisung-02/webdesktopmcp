# webdesktopmcp

**Transformez vos applications de bureau (Electron · Tauri · Wails) en serveurs WebMCP.**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | Français | [Español](README.es.md)

En quelques lignes de code, les développeurs d'applications de bureau exposent les fonctionnalités de leur application comme **outils pour les agents IA** (Claude Desktop, Claude Code, Cursor, ChatGPT Desktop…). Le code de la page utilise telle quelle l'API standard du [brouillon W3C WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`) — et la bibliothèque bascule automatiquement vers l'API native réelle dès que le runtime la fournit.

```ts
// Code de l'application — l'API standard W3C WebMCP, sans modification
document.modelContext.registerTool({
  name: "search-orders",
  description: "Rechercher des commandes par numéro de commande ou nom du client",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Numéro de commande ou nom du client" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query }, { signal }) => searchOrders(query, signal),
});
```

```jsonc
// Configuration Claude Desktop — dès que l'app tourne, les agents peuvent appeler les outils ci-dessus
{ "mcpServers": { "MyApp": {
    "command": "npx", "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }
```

## Fonctionnement

Les webviews de bureau n'embarquent pas encore l'API WebMCP native (le Chromium d'Electron est inférieur à 149 ; Tauri utilise WKWebView/WebView2). La bibliothèque ponte donc trois couches :

```
[Page dans la webview]
  document.modelContext.registerTool(...)     ← polyfill ou miroir natif (même API)
        │  IPC — protocole filaire dans docs/protocol.md
        ▼
[Hôte natif]  Electron main / Tauri (Rust) / Wails (Go)
  Registre d'outils + serveur MCP local (127.0.0.1, jeton bearer)
        │
        ├─ Streamable HTTP  ← Cursor, Claude Code, … connexion directe
        └─ @webdesktopmcp/cli (shim stdio) ← Claude Desktop, …
```

**Porte de version native d'abord** — l'adaptateur Electron vérifie `process.versions.chrome` :

- **Chromium ≥ 149** → active WebMCP natif via le commutateur `--enable-blink-features=WebMCP`. La page utilise le **vrai `document.modelContext` natif** ; l'adaptateur enveloppe uniquement `registerTool` de manière transparente pour refléter les inscriptions vers les agents externes (les agents intégrés du navigateur continuent d'emprunter le chemin natif).
- **Inférieur à 149** (tous aujourd'hui) → injecte un polyfill implémentant la sémantique W3C. La bascule est automatique — aucune modification du code applicatif.

## Paquets

| Paquet | Langage | Rôle |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | Protocole filaire partagé par les hôtes TS/Rust/Go ([spécification](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | Polyfill `document.modelContext` + miroir natif + API déclarative de formulaires |
| [`@webdesktopmcp/server`](packages/server) | TS | Serveur MCP local indépendant du framework + registre d'applications |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Adaptateur Electron (injection automatique du preload, porte de version, hook de confirmation) |
| [`@webdesktopmcp/cli`](packages/cli) | TS | Shim stdio `webdesktopmcp connect --app <nom>` |
| `crates/tauri-plugin-webdesktopmcp` | Rust | Plugin Tauri v2 |
| `go/webdesktopmcp` | Go | Paquet Wails v2 |

## Démarrage rapide Electron

```bash
npm i @webdesktopmcp/electron
```

```js
// main.js — avant app.whenReady()
const { installWebDesktopMcp } = require("@webdesktopmcp/electron");
const mcp = installWebDesktopMcp({
  appName: "MyApp",
  appVersion: "1.0.0",
  // Protéger les outils sensibles par une boîte de dialogue native (optionnel)
  confirmToolCall: async (tool, input) => { /* dialog… */ return true; },
});

const win = new BrowserWindow({
  webPreferences: { preload: mcp.preloadPath },  // recommandé (un enregistrement automatique au niveau session existe aussi)
});
```

Dans le renderer, il suffit d'utiliser le code standard `document.modelContext.registerTool` ci-dessus. L'**API déclarative par formulaires** est également prise en charge — un formulaire devient un outil sans une ligne de JavaScript :

```html
<form toolname="order-coffee"
      tooldescription="Commander un café. Prend un type de boisson et un nombre de shots, renvoie un numéro de commande."
      toolautosubmit>
  <select name="drink" toolparamdescription="Type de boisson">
    <option value="americano">americano</option>
    <option value="latte">latte</option>
  </select>
  <input type="number" name="shots" toolparamdescription="Nombre de shots" value="1" />
  <button type="submit">Commander</button>
</form>
```

Appelez `event.respondWith(result)` dans le gestionnaire submit du formulaire et cette valeur est renvoyée à l'agent (`event.agentInvoked` indique une soumission par l'agent — le `SubmitEvent#respondWith` du brouillon, polyfillé).

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
// ajouter mcp à options.Bind + injecter mcp.InitScript() dans index.html
```

Voir le README de chaque répertoire pour plus de détails.

## Connecter les agents

```bash
# Lister les applications en cours d'exécution
npx @webdesktopmcp/cli list

# Claude Desktop (stdio) — claude_desktop_config.json :
{ "mcpServers": { "MyApp": { "command": "npx",
    "args": ["-y", "@webdesktopmcp/cli", "connect", "--app", "MyApp"] } } }

# Clients compatibles HTTP (Cursor, Claude Code, …) — utiliser ce que l'app affiche :
#   URL :   http://127.0.0.1:<port>/mcp
#   Jeton : apps["MyApp"].token dans ~/.webdesktopmcp/registry.json
```

Le point de terminaison n'écoute que sur `127.0.0.1` et exige un jeton bearer. Modèle de sécurité : [docs/security.md](docs/security.md).

## Démo

```bash
pnpm install
pnpm --filter webdesktopmcp-electron-demo start
# dans un autre terminal, pendant que l'app tourne :
node packages/cli/dist/cli.js list
```

L'application de démo (`examples/electron-demo`) expose 4 outils impératifs plus un outil déclaratif de formulaire (`order-coffee`). Depuis Claude Desktop, essayez *« montre-moi les tâches ouvertes »* ou *« commande un latte avec 2 shots »*.

## État de la vérification

- `@webdesktopmcp/core` — vitest **19/19** (sémantique du polyfill, formulaires déclaratifs, miroir natif)
- `@webdesktopmcp/server` — vitest **9/9** (registre, initialize/list/call MCP sur HTTP, authentification, filtre d'exposition, hook de confirmation)
- Démo Electron — **vérifiée de bout en bout dans une vraie application** : lancement → injection du preload → 5 outils enregistrés → `tools/call` sur HTTP pour les outils impératifs et déclaratifs → également invoqués via le shim stdio CLI
- Tauri (Rust) / Wails (Go) — vérifiés via `cargo check`/`go build` et leurs suites de tests (voir les README de chaque répertoire)

## Relation avec le standard WebMCP

Cette bibliothèque apporte l'API côté page du [brouillon W3C WebMCP CG](https://webmachinelearning.github.io/webmcp/) ([dépôt](https://github.com/webmachinelearning/webmcp) ; essai d'origine dans Chrome 149 / Edge 150) aux webviews de bureau. La preuve de concept d'origine est [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP) ; l'outillage d'écosystème est assuré par MCP-B ([site](https://mcp-b.ai)). La recherche technique complète (en coréen) : [webmcp-research.md](webmcp-research.md).

## Licence

MIT
