//! Loopback MCP HTTP server over `tiny_http`.
//!
//! Binding is `127.0.0.1`-only with bearer-token auth; the endpoint speaks
//! stateless JSON (`POST /mcp` only, no SSE streams). `GET /mcp?health=1` is
//! an unauthenticated health probe so launchers/CLIs can find a live app.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response};

use crate::messages::PROTOCOL_VERSION;
use crate::rpc::{self, RpcCore};

/// Cap request bodies at 10 MB — tool arguments are small by contract.
const MAX_BODY_BYTES: u64 = 10 * 1024 * 1024;

/// A running MCP server. Dropping the handle signals the accept loop to stop
/// (best-effort; in-flight request threads finish on their own).
pub struct ServerHandle {
    /// Actually-bound port (useful when started with an ephemeral port).
    pub port: u16,
    /// Full loopback URL: `http://127.0.0.1:<port>/mcp`.
    pub url: String,
    /// Bearer token required on every authenticated request.
    pub token: String,
    server: Arc<tiny_http::Server>,
    stop: Arc<AtomicBool>,
}

impl ServerHandle {
    /// Signals the accept loop to exit and unblocks it.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.server.unblock();
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts the server and spawns its accept thread.
pub fn start(core: Arc<RpcCore>, requested_port: u16) -> Result<ServerHandle, String> {
    let token = generate_token();
    let server = tiny_http::Server::http(("127.0.0.1", requested_port))
        .map_err(|e| format!("failed to bind 127.0.0.1:{requested_port}: {e}"))?;
    let server = Arc::new(server);
    let port = server
        .server_addr()
        .to_ip()
        .map(|addr| addr.port())
        .unwrap_or(requested_port);

    let stop = Arc::new(AtomicBool::new(false));
    let accept_server = server.clone();
    let accept_stop = stop.clone();
    let accept_token = token.clone();
    std::thread::Builder::new()
        .name("webdesktopmcp-mcp".to_string())
        .spawn(move || loop {
            if accept_stop.load(Ordering::SeqCst) {
                break;
            }
            match accept_server.recv() {
                Ok(request) => {
                    let core = core.clone();
                    let token = accept_token.clone();
                    // One thread per request: `tools/call` blocks for up to
                    // 120s and must not starve `tools/list`.
                    let spawned = std::thread::Builder::new()
                        .name("webdesktopmcp-req".to_string())
                        .spawn(move || handle_request(&core, &token, request));
                    if spawned.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        })
        .map_err(|e| format!("failed to spawn accept thread: {e}"))?;

    Ok(ServerHandle {
        port,
        url: format!("http://127.0.0.1:{port}/mcp"),
        token,
        server,
        stop,
    })
}

/// 24 random bytes, hex-encoded — a 192-bit bearer token without pulling in a
/// base64 dependency.
fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("OS RNG unavailable");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Constant-time string comparison so token checks don't leak timing.
fn constant_time_equals(a: Option<&str>, b: &str) -> bool {
    let a = a.unwrap_or_default();
    let (a_bytes, b_bytes) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a_bytes.len() ^ b_bytes.len()) as u8;
    for i in 0..a_bytes.len().max(b_bytes.len()) {
        let x = a_bytes.get(i).copied().unwrap_or(0);
        let y = b_bytes.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

fn respond_json(request: tiny_http::Request, status: u16, body: &Value) {
    let content_type =
        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("valid header");
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(content_type);
    let _ = request.respond(response);
}

fn respond_empty(request: tiny_http::Request, status: u16) {
    let _ = request.respond(Response::empty(status));
}

fn handle_request(core: &Arc<RpcCore>, token: &str, mut request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (url.as_str(), None),
    };

    if path != "/mcp" {
        respond_json(
            request,
            404,
            &json!({ "error": "Not found. POST JSON-RPC to /mcp." }),
        );
        return;
    }

    // Unauthenticated health probe so launchers/CLIs can detect a live app.
    let is_health =
        query.is_some_and(|q| q.split('&').any(|pair| pair == "health=1"));
    if method == Method::Get && is_health {
        respond_json(
            request,
            200,
            &json!({
                "app": core.app_name,
                "version": core.app_version,
                "protocolVersion": PROTOCOL_VERSION,
            }),
        );
        return;
    }

    // Bearer auth from here on.
    let authorization = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .map(|header| header.value.as_str().to_string());
    let expected = format!("Bearer {token}");
    if !constant_time_equals(authorization.as_deref(), &expected) {
        respond_json(
            request,
            401,
            &json!({ "error": "Unauthorized. Pass the bearer token from the app's registry entry." }),
        );
        return;
    }

    // Stateless JSON mode: no SSE streams, no session termination.
    if method != Method::Post {
        respond_json(request, 405, &json!({ "error": "POST JSON-RPC to /mcp." }));
        return;
    }

    let mut body = String::new();
    if let Err(err) = request
        .as_reader()
        .take(MAX_BODY_BYTES)
        .read_to_string(&mut body)
    {
        respond_json(request, 400, &json!({ "error": format!("failed to read body: {err}") }));
        return;
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(parsed) => parsed,
        Err(_) => {
            respond_json(
                request,
                400,
                &json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                }),
            );
            return;
        }
    };

    match rpc::handle_json_rpc(core, &parsed) {
        Some(response) => respond_json(request, 200, &response),
        // Notification (e.g. notifications/initialized): empty body.
        None => respond_empty(request, 204),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_hex_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_compare_behaves() {
        assert!(constant_time_equals(Some("Bearer abc"), "Bearer abc"));
        assert!(!constant_time_equals(Some("Bearer abc"), "Bearer abd"));
        assert!(!constant_time_equals(Some("Bearer abc"), "Bearer ab"));
        assert!(!constant_time_equals(None, "Bearer abc"));
        assert!(constant_time_equals(None, ""));
    }
}
