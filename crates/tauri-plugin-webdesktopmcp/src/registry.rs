//! In-memory tool registry — native port of `packages/server/src/registry.ts`.
//!
//! Enforces app-wide unique tool names (one MCP namespace per app) and owns
//! the pending-invocation bookkeeping that pairs host-issued `execute`
//! messages with the renderer's `executeResult` replies.
//!
//! Pure `std`-only code: frame delivery is the caller's job. Pending
//! invocations are resolved through `std::sync::mpsc` one-shot channels so
//! both the MCP HTTP server and the Tauri command handler can block on them
//! without any async runtime.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use serde_json::{json, Value};

use crate::messages::{
    self, RegisteredToolInfo, ToolDeclaration,
};

/// Per-invocation timeout, mirroring the reference server's 120s.
pub const INVOCATION_TIMEOUT_MS: u64 = 120_000;

/// `Duration` form of [`INVOCATION_TIMEOUT_MS`].
pub fn invocation_timeout() -> Duration {
    Duration::from_millis(INVOCATION_TIMEOUT_MS)
}

/// Locks a mutex, recovering from poisoning (a panicked handler must not take
/// down the whole tool surface).
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A pending tool invocation: the host is waiting for the owning webview to
/// answer with `executeResult`.
struct Pending {
    tx: Sender<Result<String, String>>,
    /// Owning frame, kept so timeouts can propagate an `abort` message.
    frame_id: String,
}

/// Everything a caller needs to deliver an `execute` request and await its
/// result.
#[derive(Debug)]
pub struct Started {
    /// Host-issued invocation id (`inv-N` for MCP calls, `fwd-N` for forwards).
    pub invocation_id: String,
    /// Owning webview label the `execute` message must be delivered to.
    pub frame_id: String,
    /// The `execute` host message.
    pub message: Value,
    /// Resolves with the tool result (JSON string) or an error message.
    pub rx: Receiver<Result<String, String>>,
}

/// The app-wide tool registry.
#[derive(Default)]
pub struct Registry {
    tools: HashMap<String, RegisteredToolInfo>,
    pending: HashMap<String, Pending>,
    /// Last-known origin per webview label (stamped on register/getTools).
    frame_origins: HashMap<String, String>,
    next_id: u64,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_invocation_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    // -- listing -------------------------------------------------------------

    /// All registered tools.
    pub fn list(&self) -> Vec<&RegisteredToolInfo> {
        self.tools.values().collect()
    }

    /// Look up a tool by name.
    // Part of the registry's public surface; currently exercised via
    // `begin_invoke`'s internal lookup and tests.
    #[allow(dead_code)]
    pub fn get(&self, name: &str) -> Option<&RegisteredToolInfo> {
        self.tools.get(name)
    }

    /// Known frames with their last-known origin (for `toolsChanged` fans).
    pub fn frame_labels(&self) -> Vec<(String, Option<String>)> {
        let mut labels: Vec<(String, Option<String>)> = self
            .frame_origins
            .iter()
            .map(|(l, o)| (l.clone(), Some(o.clone())))
            .collect();
        for info in self.tools.values() {
            if !labels.iter().any(|(l, _)| l == &info.frame_id) {
                labels.push((info.frame_id.clone(), None));
            }
        }
        labels
    }

    // -- register / unregister ----------------------------------------------

    /// Handles a `register` from `frame_id`. Returns `(ok, error message)`.
    ///
    /// Note: a *same-frame* re-register of an existing name replaces the old
    /// entry (a page reload would otherwise strand the name forever); names
    /// claimed by a *different* frame are always rejected.
    pub fn handle_register(
        &mut self,
        frame_id: &str,
        origin: &str,
        tool: ToolDeclaration,
        exposed_to: Vec<String>,
    ) -> (bool, Option<String>) {
        if let Some(existing) = self.tools.get(&tool.name) {
            if existing.frame_id != frame_id {
                return (
                    false,
                    Some(format!(
                        "Tool name \"{}\" is already used by another webview (frame \"{}\"). Tool names must be unique within the app.",
                        tool.name, existing.frame_id
                    )),
                );
            }
        }
        self.frame_origins
            .insert(frame_id.to_string(), origin.to_string());
        self.tools.insert(
            tool.name.clone(),
            RegisteredToolInfo {
                tool,
                origin: origin.to_string(),
                frame_id: frame_id.to_string(),
                exposed_to,
            },
        );
        (true, None)
    }

    /// Handles an `unregister` from `frame_id`. Returns whether state changed.
    pub fn handle_unregister(&mut self, frame_id: &str, name: &str) -> bool {
        match self.tools.get(name) {
            Some(info) if info.frame_id == frame_id => {
                self.tools.remove(name);
                true
            }
            _ => false,
        }
    }

    /// Removes every tool owned by `frame_id` (webview destroyed).
    /// Returns whether anything changed.
    pub fn remove_frame(&mut self, frame_id: &str) -> bool {
        let before = self.tools.len();
        self.tools.retain(|_, info| info.frame_id != frame_id);
        before != self.tools.len()
    }

    /// Records the origin of a frame that may not have registered anything
    /// yet (e.g. a `getToolsRequest` from a pure agent page).
    pub fn note_frame_origin(&mut self, frame_id: &str, origin: &str) {
        self.frame_origins
            .insert(frame_id.to_string(), origin.to_string());
    }

    // -- MCP `tools/call` ----------------------------------------------------

    /// Starts a tool invocation on behalf of an external MCP client.
    /// The caller delivers `started.message` to `started.frame_id` and blocks
    /// on `started.rx` (recommendation: [`invocation_timeout`]).
    pub fn begin_invoke(&mut self, name: &str, input: Value) -> Result<Started, String> {
        let Some(info) = self.tools.get(name) else {
            return Err(format!(
                "Unknown tool \"{name}\". It may have been unregistered by the app."
            ));
        };
        let frame_id = info.frame_id.clone();
        let invocation_id = self.next_invocation_id("inv");
        let message = messages::execute_message(
            &invocation_id,
            name,
            &if input.is_null() { json!({}) } else { input },
        );
        let (tx, rx) = mpsc::channel();
        self.pending.insert(
            invocation_id.clone(),
            Pending {
                tx,
                frame_id: frame_id.clone(),
            },
        );
        Ok(Started {
            invocation_id,
            frame_id,
            message,
            rx,
        })
    }

    /// In-page agent (frame `caller_frame`) invoking another frame's tool.
    /// On success the caller delivers `started.message` and awaits `rx`;
    /// on failure the `Err` value is the `executeForwardResult` reply to
    /// deliver back to the caller.
    pub fn begin_forward(
        &mut self,
        caller_frame: &str,
        request_id: &str,
        name: &str,
        input: Value,
        from_origin: &str,
    ) -> Result<Started, Value> {
        let fail = |code: &str, message: String| -> Value {
            messages::execute_forward_result(request_id, false, None, Some(code), Some(&message))
        };
        let Some(info) = self.tools.get(name) else {
            return Err(fail("NotFoundError", format!("Tool \"{name}\" is not registered.")));
        };
        if info.frame_id == caller_frame {
            // Same frame: the local polyfill executes directly; this path is
            // effectively unreachable — respond cleanly.
            return Err(fail(
                "InvalidStateError",
                format!("Tool \"{name}\" belongs to the calling frame."),
            ));
        }
        if !info.is_exposed_to(from_origin) {
            return Err(fail(
                "SecurityError",
                format!("Tool \"{name}\" is not exposed to origin \"{from_origin}\"."),
            ));
        }
        let frame_id = info.frame_id.clone();
        let invocation_id = self.next_invocation_id("fwd");
        let message = messages::execute_message(
            &invocation_id,
            name,
            &if input.is_null() { json!({}) } else { input },
        );
        let (tx, rx) = mpsc::channel();
        self.pending.insert(
            invocation_id.clone(),
            Pending {
                tx,
                frame_id: frame_id.clone(),
            },
        );
        Ok(Started {
            invocation_id,
            frame_id,
            message,
            rx,
        })
    }

    // -- executeResult -------------------------------------------------------

    /// Handles an `executeResult` from a webview by resolving the pending
    /// channel. Returns `true` when a pending invocation was matched.
    pub fn handle_execute_result(
        &mut self,
        invocation_id: &str,
        ok: bool,
        result: Option<&str>,
        error_code: Option<&str>,
        error_message: Option<&str>,
    ) -> bool {
        let Some(pending) = self.pending.remove(invocation_id) else {
            return false;
        };
        let outcome = if ok {
            Ok(result.unwrap_or("null").to_string())
        } else {
            Err(error_message
                .or(error_code)
                .unwrap_or("Tool execution failed.")
                .to_string())
        };
        pending.tx.send(outcome).is_ok()
    }

    /// Drops a pending invocation (timeout / cancellation). Returns the
    /// owning frame so the caller can send an `abort` message.
    pub fn cancel_pending(&mut self, invocation_id: &str) -> Option<String> {
        self.pending
            .remove(invocation_id)
            .map(|pending| pending.frame_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decl(name: &str) -> ToolDeclaration {
        ToolDeclaration {
            name: name.to_string(),
            title: None,
            description: format!("{name} description"),
            input_schema: None,
            annotations: None,
        }
    }

    #[test]
    fn duplicate_names_rejected_across_frames() {
        let mut reg = Registry::new();
        let (ok, err) = reg.handle_register("main", "http://a", decl("search"), vec![]);
        assert!(ok, "first registration should succeed: {err:?}");

        let (ok, err) = reg.handle_register("panel", "http://b", decl("search"), vec![]);
        assert!(!ok);
        assert!(err.unwrap().contains("already used by another webview"));

        // Same frame re-registering replaces (page reload case).
        let (ok, _) = reg.handle_register("main", "http://a", decl("search"), vec![]);
        assert!(ok);
        assert_eq!(reg.list().len(), 1);

        // Unregister only works for the owning frame.
        assert!(!reg.handle_unregister("panel", "search"));
        assert!(reg.handle_unregister("main", "search"));
        assert!(reg.list().is_empty());
    }

    #[test]
    fn frame_removal_drops_its_tools() {
        let mut reg = Registry::new();
        reg.handle_register("main", "http://a", decl("a_tool"), vec![]);
        reg.handle_register("panel", "http://b", decl("b_tool"), vec![]);
        assert!(reg.remove_frame("main"));
        assert!(reg.get("a_tool").is_none());
        assert!(reg.get("b_tool").is_some());
        assert!(!reg.remove_frame("main"));
    }

    #[test]
    fn invoke_roundtrip_and_timeout_cleanup() {
        let mut reg = Registry::new();
        reg.handle_register("main", "http://a", decl("compute"), vec![]);

        let started = reg
            .begin_invoke("compute", json!({"x": 1}))
            .expect("tool exists");
        assert_eq!(started.frame_id, "main");
        assert_eq!(started.message["kind"], "execute");
        assert_eq!(started.message["name"], "compute");

        assert!(reg.handle_execute_result(&started.invocation_id, true, Some("\"ok\""), None, None));
        let result = started.rx.recv().unwrap().unwrap();
        assert_eq!(result, "\"ok\"");

        // Unknown invocation ids are ignored.
        assert!(!reg.handle_execute_result("inv-999", true, Some("1"), None, None));
    }

    #[test]
    fn execute_result_failure_carries_error() {
        let mut reg = Registry::new();
        reg.handle_register("main", "http://a", decl("boom"), vec![]);
        let started = reg.begin_invoke("boom", json!({})).unwrap();
        reg.handle_execute_result(
            &started.invocation_id,
            false,
            None,
            Some("ExecutionError"),
            Some("it broke"),
        );
        assert_eq!(started.rx.recv().unwrap().unwrap_err(), "it broke");
    }

    #[test]
    fn forward_enforces_exposure() {
        let mut reg = Registry::new();
        reg.handle_register(
            "main",
            "http://a",
            decl("secret"),
            vec!["http://trusted".to_string()],
        );
        reg.handle_register("panel", "http://b", decl("public"), vec![]);

        // Hidden from other origins.
        let err = reg
            .begin_forward("panel", "r1", "secret", json!({}), "http://evil")
            .unwrap_err();
        assert_eq!(err["errorCode"], "SecurityError");

        // Allowed for the exposed origin.
        let started = reg
            .begin_forward("panel", "r2", "secret", json!({}), "http://trusted")
            .expect("exposed");
        assert_eq!(started.frame_id, "main");

        // Same frame is rejected.
        let err = reg
            .begin_forward("main", "r3", "secret", json!({}), "http://trusted")
            .unwrap_err();
        assert_eq!(err["errorCode"], "InvalidStateError");

        // Unknown tool.
        let err = reg
            .begin_forward("panel", "r4", "nope", json!({}), "http://trusted")
            .unwrap_err();
        assert_eq!(err["errorCode"], "NotFoundError");
    }

    #[test]
    fn get_tools_filtering_mirrors_reference() {
        let mut reg = Registry::new();
        reg.handle_register("main", "http://a", decl("own"), vec![]);
        reg.handle_register("panel", "http://b", decl("open"), vec![]);
        reg.handle_register(
            "widget",
            "http://c",
            decl("restricted"),
            vec!["http://agent".to_string()],
        );

        let requested = |reg: &Registry, frame: &str, for_origin: &str, from: Option<Vec<String>>| {
            reg.list()
                .into_iter()
                .filter(|t| {
                    if t.frame_id == frame {
                        return true;
                    }
                    if let Some(from) = &from {
                        if !from.is_empty() && !from.iter().any(|o| o == &t.origin) {
                            return false;
                        }
                    }
                    t.is_exposed_to(for_origin)
                })
                .map(|t| t.tool.name.clone())
                .collect::<Vec<_>>()
        };

        let mut names = requested(&reg, "main", "http://agent", None);
        names.sort();
        assert_eq!(names, vec!["open", "own", "restricted"]);

        let mut names = requested(&reg, "main", "http://stranger", None);
        names.sort();
        assert_eq!(names, vec!["open", "own"]);

        // fromOrigins restriction.
        let mut names = requested(
            &reg,
            "main",
            "http://agent",
            Some(vec!["http://b".to_string()]),
        );
        names.sort();
        assert_eq!(names, vec!["open", "own"]);
    }
}
