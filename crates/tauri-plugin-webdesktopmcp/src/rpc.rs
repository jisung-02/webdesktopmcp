//! MCP JSON-RPC dispatch — pure logic over [`Registry`] + a [`FrameSink`],
//! independent of HTTP so it can be exercised directly in tests.
//!
//! Implements the stateless subset of Streamable-HTTP MCP that desktop apps
//! need: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
//! `tools/call`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::messages::RegisteredToolInfo;
use crate::registry::{self, Registry, INVOCATION_TIMEOUT_MS};

/// Default MCP protocol revision echoed when the client does not request one.
pub const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Delivers host messages to a webview. Implemented by the plugin with Tauri
/// `eval`; tests use an in-memory sink.
pub trait FrameSink: Send + Sync {
    fn send_to_frame(&self, frame: &str, message: &Value);
}

/// Shared state the JSON-RPC handlers operate on.
pub struct RpcCore {
    pub app_name: String,
    pub app_version: String,
    pub registry: Arc<Mutex<Registry>>,
    pub sink: Arc<dyn FrameSink>,
}

/// Handles a single parsed JSON-RPC request.
///
/// Returns the JSON-RPC response to send (HTTP 200), or `None` for
/// notifications (e.g. `notifications/initialized`), which get an empty 204.
pub fn handle_json_rpc(core: &RpcCore, body: &Value) -> Option<Value> {
    let Some(obj) = body.as_object() else {
        return Some(error_response(Value::Null, -32600, "Invalid Request"));
    };
    let id = obj.get("id").cloned();
    // No id => notification; nothing to answer (covers notifications/initialized).
    let Some(id) = id else {
        return None;
    };
    let Some(method) = obj.get("method").and_then(|m| m.as_str()) else {
        return Some(error_response(id, -32600, "Invalid Request: missing method"));
    };
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));

    let result = match method {
        "initialize" => Ok(initialize_result(core, &params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(list_tools(core)),
        // Always produces a result object (tool failures are `isError` results,
        // not JSON-RPC errors).
        "tools/call" => Ok(call_tool(core, &params)),
        other => Err((-32601, format!("Method not found: {other}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error_response(id, code, &message),
    })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn initialize_result(core: &RpcCore, params: &Value) -> Value {
    // Echo the client's requested protocol revision when present (matches the
    // reference SDK transport's stateless behaviour).
    let protocol_version = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_MCP_PROTOCOL_VERSION);
    json!({
        "protocolVersion": protocol_version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": core.app_name, "version": core.app_version },
    })
}

/// Tools with a non-empty `exposedTo` are in-page-agent-only and hidden from
/// external clients.
fn list_tools(core: &RpcCore) -> Value {
    let registry = registry::lock(&core.registry);
    let tools: Vec<Value> = registry
        .list()
        .into_iter()
        .filter(|tool| tool.exposed_to.is_empty())
        .map(|tool| mcp_tool(tool))
        .collect();
    json!({ "tools": tools })
}

fn mcp_tool(info: &RegisteredToolInfo) -> Value {
    let declaration = &info.tool;
    let mut tool = json!({
        "name": declaration.name,
        "description": declaration.description,
        "inputSchema": declaration
            .input_schema
            .clone()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
        "_meta": {
            "webdesktopmcp/frameId": info.frame_id,
            "webdesktopmcp/origin": info.origin,
        },
    });
    if let Some(title) = &declaration.title {
        tool["title"] = json!(title);
    }
    if let Some(annotations) = &declaration.annotations {
        let mut ann = json!({});
        if let Some(read_only) = annotations.get("readOnlyHint").and_then(|v| v.as_bool()) {
            ann["readOnlyHint"] = json!(read_only);
        }
        tool["annotations"] = ann;
    }
    tool
}

/// `tools/call`: routes to the owning webview and awaits `executeResult`.
/// Blocking is intentional: the HTTP handler runs on its own thread and the
/// registry channel carries the reply. Always returns a result object —
/// failures come back as `isError` results (mirrors the reference server).
fn call_tool(core: &RpcCore, params: &Value) -> Value {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if name.is_empty() {
        return error_result("Tool name is required.");
    }
    let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    let started = {
        let mut reg = registry::lock(&core.registry);
        reg.begin_invoke(&name, input)
    };
    let started = match started {
        Ok(started) => started,
        Err(message) => return error_result(&message),
    };

    core.sink.send_to_frame(&started.frame_id, &started.message);

    match started
        .rx
        .recv_timeout(std::time::Duration::from_millis(INVOCATION_TIMEOUT_MS))
    {
        Ok(Ok(result)) => {
            let mut response = json!({ "content": [{ "type": "text", "text": result }] });
            if let Ok(structured) = serde_json::from_str::<Value>(response["content"][0]["text"].as_str().unwrap_or_default()) {
                response["structuredContent"] = structured;
            }
            response
        }
        Ok(Err(message)) => error_result(&message),
        Err(_) => {
            let abort_target = registry::lock(&core.registry).cancel_pending(&started.invocation_id);
            if let Some(frame) = abort_target {
                core.sink
                    .send_to_frame(&frame, &crate::messages::abort_message(&started.invocation_id));
            }
            error_result(&format!(
                "Tool \"{name}\" timed out after {INVOCATION_TIMEOUT_MS}ms (no response from the app webview)."
            ))
        }
    }
}

fn error_result(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Registry;
    use serde_json::json;
    use std::time::Duration;

    struct MockSink {
        messages: Mutex<Vec<(String, Value)>>,
    }

    impl FrameSink for MockSink {
        fn send_to_frame(&self, frame: &str, message: &Value) {
            self.messages.lock().unwrap().push((frame.to_string(), message.clone()));
        }
    }

    fn setup() -> (RpcCore, Arc<Mutex<Registry>>, Arc<MockSink>) {
        let registry = Arc::new(Mutex::new(Registry::new()));
        let sink = Arc::new(MockSink { messages: Mutex::new(Vec::new()) });
        let core = RpcCore {
            app_name: "TestApp".to_string(),
            app_version: "1.2.3".to_string(),
            registry: registry.clone(),
            sink: sink.clone(),
        };
        (core, registry, sink)
    }

    fn register(core: &RpcCore, name: &str, exposed_to: Vec<String>) {
        let tool = json!({ "name": name, "description": format!("{name} desc") });
        let decl = crate::messages::validate_declaration(&tool).unwrap();
        registry::lock(&core.registry)
            .handle_register("main", "http://localhost:3000", decl, exposed_to);
    }

    #[test]
    fn initialize_reports_server_info() {
        let (core, _registry, _sink) = setup();
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-03-26" }
        });
        let response = handle_json_rpc(&core, &body).expect("a response");
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(response["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(response["result"]["serverInfo"]["name"], "TestApp");
        assert_eq!(response["result"]["serverInfo"]["version"], "1.2.3");
    }

    #[test]
    fn tools_list_hides_exposed_to_and_sets_meta() {
        let (core, _registry, _sink) = setup();
        register(&core, "visible", vec![]);
        register(&core, "agent_only", vec!["http://localhost:3000".to_string()]);

        let body = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let response = handle_json_rpc(&core, &body).unwrap();
        let tools = response["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1, "exposedTo tools must be hidden: {tools:?}");
        assert_eq!(tools[0]["name"], "visible");
        assert_eq!(tools[0]["description"], "visible desc");
        // Raw JSON Schema passthrough with the spec default when absent.
        assert_eq!(tools[0]["inputSchema"], json!({ "type": "object", "properties": {} }));
        assert_eq!(tools[0]["_meta"]["webdesktopmcp/frameId"], "main");
        assert_eq!(tools[0]["_meta"]["webdesktopmcp/origin"], "http://localhost:3000");
    }

    #[test]
    fn notification_and_unknown_method() {
        let (core, _registry, _sink) = setup();
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle_json_rpc(&core, &initialized).is_none(), "notifications get no body");

        let unknown = json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" });
        let response = handle_json_rpc(&core, &unknown).unwrap();
        assert_eq!(response["error"]["code"], -32601);

        let ping = json!({ "jsonrpc": "2.0", "id": 10, "method": "ping" });
        let response = handle_json_rpc(&core, &ping).unwrap();
        assert_eq!(response["result"], json!({}));
    }

    #[test]
    fn tools_call_round_trip_with_renderer() {
        let (core, registry, sink) = setup();
        register(&core, "greeter", vec![]);

        let core_for_thread = RpcCore {
            app_name: core.app_name.clone(),
            app_version: core.app_version.clone(),
            registry: core.registry.clone(),
            sink: core.sink.clone(),
        };
        let handle = std::thread::spawn(move || {
            handle_json_rpc(
                &core_for_thread,
                &json!({
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": { "name": "greeter", "arguments": { "who": "world" } }
                }),
            )
            .unwrap()
        });

        // Wait for the execute message to reach the (mock) frame.
        let (frame, message) = loop {
            {
                let messages = sink.messages.lock().unwrap();
                if let Some(pair) = messages.iter().find(|(_, m)| m["kind"] == "execute") {
                    break pair.clone();
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(frame, "main");
        let invocation_id = message["invocationId"].as_str().unwrap().to_string();

        registry::lock(&registry).handle_execute_result(
            &invocation_id,
            true,
            Some("{\"hello\":\"world\"}"),
            None,
            None,
        );

        let response = handle.join().unwrap();
        assert_eq!(response["result"]["content"][0]["type"], "text");
        assert_eq!(response["result"]["content"][0]["text"], "{\"hello\":\"world\"}");
        assert_eq!(response["result"]["structuredContent"], json!({ "hello": "world" }));
    }

    #[test]
    fn tools_call_unknown_tool_is_error_result() {
        let (core, _registry, _sink) = setup();
        let body = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": { "name": "ghost" }
        });
        let response = handle_json_rpc(&core, &body).unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert!(response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Unknown tool"));
    }

    #[test]
    fn tools_call_execution_failure_is_error_result() {
        let (core, registry, sink) = setup();
        register(&core, "broken", vec![]);
        let body = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": { "name": "broken" }
        });
        // Run the call on a thread; answer it through the registry exactly
        // like the `send` command handler would when executeResult arrives.
        let core2 = RpcCore {
            app_name: core.app_name.clone(),
            app_version: core.app_version.clone(),
            registry: core.registry.clone(),
            sink: core.sink.clone(),
        };
        let handle = std::thread::spawn(move || handle_json_rpc(&core2, &body).unwrap());
        let (frame, message) = loop {
            {
                let messages = sink.messages.lock().unwrap();
                if let Some(pair) = messages.iter().find(|(_, m)| m["kind"] == "execute") {
                    break pair.clone();
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(frame, "main");
        let invocation_id = message["invocationId"].as_str().unwrap().to_string();
        registry::lock(&registry).handle_execute_result(
            &invocation_id,
            false,
            None,
            Some("ExecutionError"),
            Some("rendered exploded"),
        );
        let response = handle.join().unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(response["result"]["content"][0]["text"], "rendered exploded");
    }
}
