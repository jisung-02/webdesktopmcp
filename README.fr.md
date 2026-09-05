# webdesktopmcp

**Un pont expérimental WebMCP-to-MCP pour Electron · Tauri · Wails**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Español](README.es.md)

Exposez les fonctions de la page aux agents externes via un serveur MCP local et un relais CLI stdio. Le [brouillon CG WebMCP du 4 septembre 2026](https://webmachinelearning.github.io/webmcp/) n’est ni une norme W3C ni un document du W3C Standards Track. Cette bibliothèque ne revendique pas une conformité complète.

```ts
// Experimental WebMCP draft API
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

## Prise en charge · 2026-09-05

Le mode natif dépend de la détection des méthodes nécessaires de `document.modelContext` à l’exécution. Une version ou un indicateur ne garantit pas leur disponibilité. [Electron 44 inclut Chromium 152](https://www.electronjs.org/blog/electron-44-0) ; [Chrome propose un origin trial depuis 149](https://developer.chrome.com/docs/ai/webmcp).

Le mode polyfill des trois adaptateurs partage une implémentation et un sous-ensemble des formulaires déclaratifs. Le miroir natif observe seulement les appels impératifs à `registerTool` effectués après son installation. Les formulaires déclaratifs natifs ne sont pas exposés aux clients MCP externes. Les deux modes ne sont pas identiques.

La bibliothèque ne reproduit pas toute l’isolation iframe/Permissions Policy et n’interdit pas l’exécution headless. Les outils doivent valider leurs entrées : aucune validation JSON Schema à l’exécution n’est fournie. Un `exposedTo` non vide exclut la découverte et les appels externes selon une politique propre à la bibliothèque.

## Paquets

| Paquet | Langage | Rôle |
|---|---|---|
| [`@webdesktopmcp/protocol`](packages/protocol) | TS | Protocole filaire partagé par les hôtes TS/Rust/Go ([spécification](docs/protocol.md)) |
| [`@webdesktopmcp/core`](packages/core) | TS | Polyfill `document.modelContext` + miroir natif + API déclarative de formulaires |
| [`@webdesktopmcp/server`](packages/server) | TS | Serveur MCP local indépendant du framework + registre d'applications |
| [`@webdesktopmcp/electron`](packages/electron) | TS | Adaptateur Electron (injection automatique du preload, détection de fonctions, hook de confirmation) |
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

Dans le renderer, il suffit d'utiliser le code `document.modelContext.registerTool` ci-dessus. Pour l'inférence de types, utilisez l'assistant `defineTool` de `@webdesktopmcp/core` (le type de l'entrée est inféré dans `execute`). Pendant le débogage, `window.__webDesktopMcp.listTools()` dans la console DevTools liste les outils enregistrés par la page. L'**API déclarative par formulaires** est également prise en charge — un formulaire devient un outil sans une ligne de JavaScript :

```html
<!-- Polyfill mode: native declarative forms are not mirrored externally. -->
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

# Lister les outils d’une application en cours d’exécution
npx @webdesktopmcp/cli tools --app "MyApp"

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

Exemple en mode polyfill : L'application de démo (`examples/electron-demo`) expose 4 outils impératifs plus un outil déclaratif de formulaire (`order-coffee`). Depuis Claude Desktop, essayez *« montre-moi les tâches ouvertes »* ou *« commande un latte avec 2 shots »*.

## État de la vérification

Installation, configuration Tauri/Wails et CLI : [guide anglais](README.md). La [matrice de prise en charge](docs/support.md) définit les fonctionnalités et la portée des vérifications ; voir aussi la [sécurité](docs/security.md). Les tests locaux ne prouvent ni la conformité aux WPT officiels ni la validation des interfaces natives sur toutes les plateformes.

```bash
pnpm build
pnpm test
pnpm typecheck
```

## Relation avec le brouillon WebMCP

Exposez les fonctions de la page aux agents externes via un serveur MCP local et un relais CLI stdio. Le [brouillon CG WebMCP du 4 septembre 2026](https://webmachinelearning.github.io/webmcp/) n’est ni une norme W3C ni un document du W3C Standards Track. Cette bibliothèque ne revendique pas une conformité complète.

[Support and verification](docs/support.md) · [Research notes](webmcp-research.md)

## Licence

MIT

[References and implementation evidence](docs/references.md)
