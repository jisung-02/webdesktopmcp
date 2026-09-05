# Support and verification

Official sources and their implementation/test mapping: [References](references.md).

Reviewed 2026-09-05. This is the source of truth for the library's scope; browser availability may change independently of a package release.

## Status

webdesktopmcp is an experimental desktop WebMCP-to-MCP bridge. The upstream [4 September 2026 Community Group draft](https://webmachinelearning.github.io/webmcp/) explicitly says it is neither a W3C Standard nor on the W3C Standards Track. Supporting some draft methods does not establish conformance.

[Chrome's official documentation](https://developer.chrome.com/docs/ai/webmcp) describes an origin trial from Chrome 149. [Electron 44](https://www.electronjs.org/blog/electron-44-0), released 25 August 2026, includes Chromium 152. Neither a version threshold nor enabling a Blink flag proves that a particular desktop document has a compatible native API. Native mode requires feature detection at runtime; otherwise the shared page polyfill is installed.

## Implementation matrix

| Capability | Polyfill mode (Electron / Tauri / Wails) | Native mirror mode |
|---|---|---|
| Imperative registration | Shared TypeScript page implementation, injected by each adapter | Wraps native `registerTool` after installation and mirrors acknowledged registrations |
| Registration lifetime | Registration `AbortSignal`; `unregisterTool` is a library extension | Registration signal; no requirement for a native `unregisterTool` method |
| External MCP list/call | Host registry, HTTP endpoint, CLI stdio bridge | Mirrored imperative registrations only |
| Declarative forms | Library subset: annotated forms, schema synthesis for supported controls, submission and response handling | Native browser forms may exist, but are not mirrored externally |
| Page discovery/execution | Library routing and exposure checks | Native browser implementation for native page APIs; host policy for external MCP |
| JSON Schema validation | Metadata is forwarded; no runtime `required`/`type` validation of tool arguments | External bridge does not add validation; native behavior is runtime dependent |
| Browser security model | Partial desktop adaptation; not complete browser Permissions Policy or traversable/iframe isolation | Browser governs its own API; external MCP remains a separate trust boundary |
| Cancellation | Page-to-host cancellation is forwarded. CLI cancellation closes its per-call HTTP request; host disconnect handling is adapter dependent. Callbacks must observe the signal. | External callback cancellation is separate from native browser execution |

Stateless HTTP `notifications/cancelled` sent on a separate request are not correlated with an active invocation. Do not assume every external MCP client cancellation reaches the page.

`getTools({ fromOrigins })` adds requested foreign origins to same-origin discovery; it does not remove own/same-origin tools. Foreign discovery also requires the tool’s `exposedTo` permission. Native `RegisteredTool.window` identifies the owning window; desktop routing uses the library’s `frameId`. A `getTools` AbortSignal option is a library extension, whereas execution options use the registration-independent execution signal.

The declarative subset is not a complete implementation of browser form algorithms, native pseudo-classes, accessibility observations, or navigation-driven results. Prefer imperative registration for tools that must be available externally in either mode. Tools registered before mirror installation cannot be recovered merely by wrapping future `registerTool` calls.

## Adapter boundaries

| Adapter | Runtime and trust boundary |
|---|---|
| Electron | Preload/IPC accepts main-frame messages only; DOM child iframe messages are rejected. native API availability depends on the document and runtime. Use trusted application content and the adapter's supported frame routing. |
| Tauri v2 | Generated shared page script and Rust host. Supports WebviewWindow callers; ordinary-window child webviews are rejected. Host webview URL identifies the webview; it is not authenticated DOM subframe identity. |
| Wails v2 | Generated shared page script and Go host. The bound `Send(frameId, message)` API assumes trusted app renderer code. Cross-frame origins require host `SetFrameOrigin` configuration; renderer-supplied IDs are not browser-authenticated frame identities. |

The library does not enforce visible windows or prohibit headless execution. Applications control window visibility and user confirmation. A nonempty registration `exposedTo` list excludes a tool from both external MCP discovery and calls; this is a library policy reserving those tools for page clients, not an implementation of browser-origin access control for external agents. See [security](security.md).

## Verification scope

Run the commands in the [main README](../README.md#verification-status) against the checkout being evaluated. Tests exercise the shared implementation with DOM/native-shaped fixtures, host protocol/security behavior, and React lifecycle. Rust/Go checks depend on installed toolchains and platform libraries. Passing those checks does not prove native browser compatibility.

No official Web Platform Tests conformance run or complete native Electron/Tauri/Wails GUI matrix is claimed. A native-shaped mock is a regression fixture, not evidence from Chromium. Validate actual target versions, packaging, navigation, permissions, and native/declarative behavior in your own desktop application before release.

### Recorded Electron integration run

On 2026-09-05, `pnpm --filter @webdesktopmcp/electron test:smoke` passed on Electron **38.8.6 / Chromium 140.0.7339.249** with a visible BrowserWindow and `native: "off"`. The local HTTP page exercised actual preload injection, forced-polyfill configuration, MCP list/call for imperative and declarative tools, visible DOM results, page discovery/execution, registration abort, and reload cleanup/re-registration. The test uses a unique temporary app registration and removes it on exit. This verifies the polyfill integration path on this runtime, not native WebMCP or other platform GUIs.
