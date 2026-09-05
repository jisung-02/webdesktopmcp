//! The single IPC command pages call: `plugin:webdesktopmcp|send`.
//!
//! Parses [`RendererMessage`] kinds per docs/protocol.md and drives the
//! registry. Replies travel back over the bridge (host-side `eval` of
//! `__webDesktopMcpHost._deliver(...)`), not through the IPC promise.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};

use crate::messages::{self, RendererMessage};
use crate::registry::{self, invocation_timeout, Registry};
use crate::rpc::RpcCore;
use crate::{deliver, notify_change, PluginState};

#[tauri::command]
pub(crate) async fn send(window: tauri::Webview<Wry>, message: Value) -> Result<(), String> {
    let app = window.app_handle().clone();
    if app.get_webview_window(window.label()).is_none() {
        return Err("webdesktopmcp supports WebviewWindow callers only".into());
    }
    let (registry, core) = {
        let Some(state) = app.try_state::<PluginState>() else {
            return Ok(());
        };
        (state.registry.clone(), state.core.clone())
    };
    let frame = window.label().to_string();
    let url = window
        .url()
        .map_err(|error| format!("Cannot identify calling webview origin: {error}"))?;
    let origin = messages::normalize_origin(url.as_str());
    handle_renderer_message(&app, &registry, &core, &frame, &origin, message).await;
    Ok(())
}

enum ForwardOutcome {
    Done(Result<String, String>),
    Timeout,
}

async fn handle_renderer_message(
    app: &AppHandle<Wry>,
    registry: &Arc<Mutex<Registry>>,
    _core: &Arc<RpcCore>,
    frame: &str,
    origin: &str,
    message: Value,
) {
    let parsed = match messages::parse_renderer_message(&message) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("[webdesktopmcp:{frame}] dropping malformed message: {error}");
            return;
        }
    };

    match parsed {
        RendererMessage::Register {
            invocation_id,
            tool,
            exposed_to,
        } => {
            let declaration = match messages::validate_declaration(&tool) {
                Ok(declaration) => declaration,
                Err(error) => {
                    deliver(
                        app,
                        frame,
                        &messages::register_result(&invocation_id, false, Some(&error)),
                    );
                    return;
                }
            };
            let (ok, error) =
                registry::lock(registry).handle_register(frame, origin, declaration, exposed_to);
            deliver(
                app,
                frame,
                &messages::register_result(&invocation_id, ok, error.as_deref()),
            );
            if ok {
                notify_change(app, registry);
            }
        }

        RendererMessage::Unregister { name } | RendererMessage::ToolRemoved { name } => {
            if registry::lock(registry).handle_unregister(frame, &name) {
                notify_change(app, registry);
            }
        }

        RendererMessage::ExecuteResult {
            invocation_id,
            ok,
            result,
            error_code,
            error_message,
        } => {
            registry::lock(registry).handle_execute_result(
                frame,
                &invocation_id,
                ok,
                result.as_deref(),
                error_code.as_deref(),
                error_message.as_deref(),
            );
        }

        RendererMessage::ExecuteForward {
            request_id,
            name,
            input,
        } => {
            let started =
                registry::lock(registry).begin_forward(frame, &request_id, &name, input, origin);
            let started = match started {
                Ok(started) => started,
                Err(reply) => {
                    deliver(app, frame, &reply);
                    return;
                }
            };
            deliver(app, &started.frame_id, &started.message);
            let invocation_id = started.invocation_id.clone();
            // The owning frame answers via a separate `send(executeResult)`;
            // the blocking wait runs on the blocking pool, not a runtime worker.
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                match started.rx.recv_timeout(invocation_timeout()) {
                    Ok(Ok(result)) => ForwardOutcome::Done(Ok(result)),
                    Ok(Err(message)) => ForwardOutcome::Done(Err(message)),
                    Err(_) => ForwardOutcome::Timeout,
                }
            })
            .await
            .unwrap_or(ForwardOutcome::Timeout);
            match outcome {
                ForwardOutcome::Done(Ok(result)) => {
                    deliver(
                        app,
                        frame,
                        &messages::execute_forward_result(
                            &request_id,
                            true,
                            Some(&result),
                            None,
                            None,
                        ),
                    );
                }
                ForwardOutcome::Done(Err(message)) => {
                    deliver(
                        app,
                        frame,
                        &messages::execute_forward_result(
                            &request_id,
                            false,
                            None,
                            Some("ExecutionError"),
                            Some(&message),
                        ),
                    );
                }
                ForwardOutcome::Timeout => {
                    let abort_frame = registry::lock(registry).cancel_pending(&invocation_id);
                    if let Some(owner) = abort_frame {
                        deliver(app, &owner, &messages::abort_message(&invocation_id));
                    }
                    deliver(
                        app,
                        frame,
                        &messages::execute_forward_result(
                            &request_id,
                            false,
                            None,
                            Some("TimeoutError"),
                            Some(&format!("Forwarded call to \"{name}\" timed out.")),
                        ),
                    );
                }
            }
        }

        RendererMessage::CancelForward { request_id } => {
            let cancelled = registry::lock(registry).cancel_forward(frame, &request_id);
            if let Some((owner, invocation)) = cancelled {
                deliver(app, &owner, &messages::abort_message(&invocation));
            }
        }

        RendererMessage::GetToolsRequest {
            request_id,
            from_origins,
        } => {
            let response = {
                let mut reg = registry::lock(registry);
                reg.note_frame_origin(frame, origin);
                let tools: Vec<Value> = reg
                    .list_for_origin(origin, from_origins.as_deref())
                    .into_iter()
                    .map(|tool| tool.to_wire())
                    .collect();
                messages::get_tools_response(&request_id, &tools)
            };
            deliver(app, frame, &response);
        }

        RendererMessage::Log { level, message } => {
            eprintln!("[webdesktopmcp:{frame}] {level}: {message}");
        }
    }
}
