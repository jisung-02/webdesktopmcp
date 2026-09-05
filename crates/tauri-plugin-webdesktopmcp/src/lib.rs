//! # tauri-plugin-webdesktopmcp
//!
//! Lets any Tauri v2 app expose the WebMCP tools registered by its webviews
//! to external MCP clients (Claude Desktop, Cursor, any MCP SDK) over a
//! loopback Streamable-HTTP endpoint guarded by a bearer token.
//!
//! Wire contract: `docs/protocol.md`. Native port of the reference
//! TypeScript host (`@webdesktopmcp/server`) — same registry semantics, same
//! registry-file format, same bootstrap bridge global.
//!
//! ## Usage
//!
//! ```ignore
//! fn main() {
//!     tauri::Builder::default()
//!         .plugin(tauri_plugin_webdesktopmcp::init(
//!             tauri_plugin_webdesktopmcp::WebDesktopMcpConfig::new("My App", "1.0.0"),
//!         ))
//!         .run(tauri::generate_context!())
//!         .expect("error while running tauri application");
//! }
//! ```
//!
//! The plugin injects the generated shared bootstrap into every webview on page load
//! (idempotently) and exposes [`init_script`] for apps that prefer manual
//! injection via `WebviewWindowBuilder::initialization_script(init_script())`
//! for guaranteed pre-parse timing.
//!
//! The loopback endpoint URL + bearer token are written to
//! `~/.webdesktopmcp/registry.json` (mode 0600) and can be read at runtime
//! with [`endpoint`]. They are removed when the plugin state drops.

#![forbid(unsafe_code)]

pub mod app_registry;
mod commands;
mod config;
pub mod messages;
// Public so host integrations (and tests) can drive the registry and the
// MCP server directly, without a running Tauri app.
pub mod registry;
pub mod rpc;
pub mod server;

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};

use crate::registry::Registry;
use crate::rpc::RpcCore;

pub use config::WebDesktopMcpConfig;

/// Tauri plugin name — pages invoke the bridge via
/// `plugin:webdesktopmcp|send`.
pub const PLUGIN_NAME: &str = "webdesktopmcp";

/// The generated main-world bootstrap: host bridge, native mirror/polyfill,
/// and declarative forms from the shared TypeScript core.
pub const BOOTSTRAP_JS: &str = include_str!("bootstrap.js");

/// Returns the bootstrap script contents for apps that prefer manual
/// injection, e.g. `WebviewWindowBuilder::initialization_script(init_script())`.
pub fn init_script() -> String {
    BOOTSTRAP_JS.to_string()
}

/// Internal managed plugin state.
pub(crate) struct PluginState {
    pub(crate) config: WebDesktopMcpConfig,
    pub(crate) registry: Arc<Mutex<Registry>>,
    pub(crate) core: Arc<RpcCore>,
    pub(crate) server: Option<server::ServerHandle>,
}

impl Drop for PluginState {
    fn drop(&mut self) {
        // Best-effort: the registry entry goes away when the app shuts down
        // cleanly. Stale entries of crashed apps are pruned by the next
        // writer (`kill -0` probe).
        app_registry::remove_entry(&self.config.app_name);
        if let Some(server) = &self.server {
            server.shutdown();
        }
    }
}

/// Returns `(loopback MCP URL, bearer token)` for this app, if the server
/// started. Mirrors the values written to `~/.webdesktopmcp/registry.json`.
pub fn endpoint(handle: &AppHandle<Wry>) -> Option<(String, String)> {
    handle.try_state::<PluginState>().and_then(|state| {
        state
            .server
            .as_ref()
            .map(|server| (server.url.clone(), server.token.clone()))
    })
}

/// Builds the plugin. Register it with `tauri::Builder::plugin`.
pub fn init(config: WebDesktopMcpConfig) -> tauri::plugin::TauriPlugin<Wry> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![commands::send])
        .setup(move |app, _api| {
            // Plugin setup hands us the AppHandle (tauri 2.x signature).
            setup(app, config.clone());
            Ok(())
        })
        // Auto-inject the bootstrap on page load (both edges for robustness —
        // the script is idempotent). For guaranteed pre-parse timing, apps can
        // additionally use `initialization_script(init_script())`.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(state) = webview.app_handle().try_state::<PluginState>() {
                    let (changed, aborts) =
                        registry::lock(&state.registry).remove_frame(webview.label());
                    for (owner, invocation) in aborts {
                        deliver(
                            webview.app_handle(),
                            &owner,
                            &messages::abort_message(&invocation),
                        );
                    }
                    if changed {
                        notify_change(webview.app_handle(), &state.registry);
                    }
                }
            }
            let inject = matches!(
                payload.event(),
                tauri::webview::PageLoadEvent::Started | tauri::webview::PageLoadEvent::Finished
            );
            if inject {
                let _ = webview.eval(BOOTSTRAP_JS);
            }
        })
        // Webview teardown: drop its tools and tell the other frames.
        .on_window_ready(|window| {
            let app = window.app_handle().clone();
            let label = window.label().to_string();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Some(state) = app.try_state::<PluginState>() {
                        let (changed, aborts) =
                            registry::lock(&state.registry).remove_frame(&label);
                        for (owner, invocation) in aborts {
                            deliver(&app, &owner, &messages::abort_message(&invocation));
                        }
                        if changed {
                            notify_change(&app, &state.registry);
                        }
                    }
                }
            });
        })
        .build()
}

fn setup(app: &AppHandle<Wry>, config: WebDesktopMcpConfig) {
    let handle = app.clone();
    let registry = Arc::new(Mutex::new(Registry::new()));
    let core = Arc::new(RpcCore {
        app_name: config.app_name.clone(),
        app_version: config.app_version.clone(),
        registry: registry.clone(),
        sink: Arc::new(TauriSink {
            app: handle.clone(),
        }),
    });

    let server = match server::start(core.clone(), config.port.unwrap_or(0)) {
        Ok(server) => {
            if let Err(error) =
                app_registry::upsert_entry(&config.app_name, &server.url, &server.token)
            {
                eprintln!("[webdesktopmcp] failed to write app registry entry: {error}");
            }
            eprintln!(
                "[webdesktopmcp] MCP endpoint {} (app \"{}\", port {})",
                server.url, config.app_name, server.port
            );
            Some(server)
        }
        Err(error) => {
            eprintln!("[webdesktopmcp] MCP server disabled: {error}");
            None
        }
    };

    app.manage(PluginState {
        config,
        registry,
        core,
        server,
    });
}

/// [`rpc::FrameSink`] backed by Tauri: evaluates the `_deliver` call in the
/// target webview's main world.
struct TauriSink {
    app: AppHandle<Wry>,
}

impl rpc::FrameSink for TauriSink {
    fn send_to_frame(&self, frame: &str, message: &Value) {
        deliver(&self.app, frame, message);
    }
}

/// Delivers a host message to a webview by evaluating
/// `window.__webDesktopMcpHost._deliver(<json>)` in its main world.
///
/// The eval is wrapped in `run_on_main_thread` — webview APIs are main-thread
/// only on some platforms, and this form is safe everywhere.
pub(crate) fn deliver(app: &AppHandle<Wry>, frame: &str, message: &Value) {
    let Ok(json) = serde_json::to_string(message) else {
        return;
    };
    let script =
        format!("window.__webDesktopMcpHost && window.__webDesktopMcpHost._deliver({json});");
    let app_for_main = app.clone();
    let label = frame.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(webview) = app_for_main.get_webview_window(&label) {
            let _ = webview.eval(&script);
        }
    });
}

/// Broadcasts a registry change: `toolsChanged` snapshots to every known
/// frame (own tools excluded, `exposedTo` honored) plus an app-level Tauri
/// event for hosts that want raw visibility.
pub(crate) fn notify_change(app: &AppHandle<Wry>, registry: &Arc<Mutex<Registry>>) {
    let deliveries: Vec<(String, Value)> = {
        let reg = registry::lock(registry);
        reg.frame_labels()
            .into_iter()
            .map(|(label, origin)| {
                let tools: Vec<Value> = reg
                    .list()
                    .into_iter()
                    .filter(|tool| tool.frame_id != label)
                    .filter(|tool| {
                        origin
                            .as_deref()
                            .is_some_and(|origin| tool.is_exposed_to(origin))
                    })
                    .map(|tool| tool.to_wire())
                    .collect();
                (label, messages::tools_changed(&tools))
            })
            .collect()
    };
    for (frame, message) in deliveries {
        deliver(app, &frame, &message);
    }
    use tauri::Emitter;
    let total = registry::lock(registry).list().len();
    let _ = app.emit("webdesktopmcp://tools-changed", total);
}
