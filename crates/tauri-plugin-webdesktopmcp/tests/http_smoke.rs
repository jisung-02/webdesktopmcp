//! End-to-end smoke test of the loopback MCP HTTP server (no Tauri app
//! required): binds a real server on 127.0.0.1 and speaks raw HTTP.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri_plugin_webdesktopmcp::messages::ToolDeclaration;
use tauri_plugin_webdesktopmcp::registry::{self, Registry};
use tauri_plugin_webdesktopmcp::rpc::{FrameSink, RpcCore};
use tauri_plugin_webdesktopmcp::server;

struct NullSink;

impl FrameSink for NullSink {
    fn send_to_frame(&self, _frame: &str, _message: &Value) {}
}

struct RecordingSink {
    messages: Mutex<Vec<(String, Value)>>,
}

impl FrameSink for RecordingSink {
    fn send_to_frame(&self, frame: &str, message: &Value) {
        self.messages.lock().unwrap().push((frame.to_string(), message.clone()));
    }
}

fn start_server() -> (server::ServerHandle, Arc<Mutex<Registry>>) {
    let registry = Arc::new(Mutex::new(Registry::new()));
    // Register a tool as if a webview had (origin stamping included).
    let declaration = ToolDeclaration {
        name: "search_docs".to_string(),
        title: Some("Search docs".to_string()),
        description: "Searches the docs".to_string(),
        input_schema: Some(json!({
            "type": "object",
            "properties": { "q": { "type": "string" } }
        })),
        annotations: None,
    };
    registry::lock(&registry).handle_register("main", "tauri://localhost", declaration, vec![]);

    let core = Arc::new(RpcCore {
        app_name: "SmokeApp".to_string(),
        app_version: "9.9.9".to_string(),
        registry: registry.clone(),
        sink: Arc::new(RecordingSink { messages: Mutex::new(Vec::new()) }),
    });
    let handle = server::start(core, 0).expect("server starts on an ephemeral port");
    assert!(handle.url.starts_with("http://127.0.0.1:"));
    (handle, registry)
}

/// Sends a raw HTTP request and returns the full response as a string.
fn raw_request(port: u16, request: &str) -> String {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.write_all(request.as_bytes()).expect("write");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read");
    response
}

fn post_json(port: u16, token: Option<&str>, body: &Value) -> (u16, String) {
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAuthorization: {}\r\nConnection: close\r\n\r\n{}",
        body.to_string().len(),
        token.map(|t| format!("Bearer {t}")).unwrap_or_default(),
        body
    );
    let response = raw_request(port, &request);
    let status: u16 = response
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    (status, body)
}

#[test]
fn health_auth_and_rpc_end_to_end() {
    let (server, _registry) = start_server();
    let port = server.port;

    // Unauthenticated health probe.
    let response = raw_request(port, "GET /mcp?health=1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    let health: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(health, json!({ "app": "SmokeApp", "version": "9.9.9", "protocolVersion": 1 }));

    // Missing/wrong token -> 401 JSON body.
    let (status, _) = post_json(port, None, &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }));
    assert_eq!(status, 401);
    let (status, _) = post_json(port, Some("wrong"), &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }));
    assert_eq!(status, 401);

    // Other paths -> 404; GET without health -> 405.
    let response = raw_request(
        port,
        &format!(
            "GET /other HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            server.token
        ),
    );
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    let response = raw_request(
        port,
        &format!(
            "GET /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            server.token
        ),
    );
    assert!(response.starts_with("HTTP/1.1 405"), "{response}");

    // Authenticated ping + tools/list through the real HTTP stack.
    let (status, body) = post_json(
        port,
        Some(&server.token),
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }),
    );
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"], json!({}));

    let (status, body) = post_json(
        port,
        Some(&server.token),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    );
    assert_eq!(status, 200);
    let response = serde_json::from_str::<Value>(&body).unwrap();
    let tool = &response["result"]["tools"][0];
    assert_eq!(tool["name"], "search_docs");
    assert_eq!(tool["title"], "Search docs");
    assert_eq!(tool["_meta"]["webdesktopmcp/frameId"], "main");
    assert_eq!(tool["_meta"]["webdesktopmcp/origin"], "tauri://localhost");
    assert_eq!(
        tool["inputSchema"],
        json!({ "type": "object", "properties": { "q": { "type": "string" } } })
    );

    // Notification -> empty 204.
    let (status, body) = post_json(
        port,
        Some(&server.token),
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    );
    assert_eq!(status, 204);
    assert!(body.is_empty());
}
