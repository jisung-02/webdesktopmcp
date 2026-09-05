//! Wire-protocol types for webdesktopmcp v1 — the Rust mirror of
//! `packages/protocol/src/index.ts` and `docs/protocol.md`.
//!
//! Pure data + parsing/validation helpers: no Tauri types here so everything
//! is unit-testable in isolation.

use serde_json::{json, Value};
use tauri::Url;

/// Wire protocol version implemented by this plugin.
pub const PROTOCOL_VERSION: u32 = 1;

/// Name grammar from the W3C WebMCP draft: 1–128 chars of `[A-Za-z0-9_.-]`.
const TOOL_NAME_MAX_LEN: usize = 128;

/// Validates a tool name against the spec grammar.
pub fn is_valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= TOOL_NAME_MAX_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// A tool declaration as sent by the page (`ToolDeclaration` in the protocol).
/// `inputSchema` is kept as a raw JSON value — page-declared schemas must
/// reach MCP clients verbatim (no conversion layer).
#[derive(Debug, Clone)]
pub struct ToolDeclaration {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub input_schema: Option<Value>,
    pub annotations: Option<Value>,
}

/// A registered tool enriched with frame provenance (`RegisteredToolInfo`).
#[derive(Debug, Clone)]
pub struct RegisteredToolInfo {
    pub tool: ToolDeclaration,
    /// Origin of the registering document, stamped by the host.
    pub origin: String,
    /// Tauri webview label of the owning frame.
    pub frame_id: String,
    /// Empty = same-origin pages and external MCP; non-empty also allows listed page origins.
    pub exposed_to: Vec<String>,
}

impl RegisteredToolInfo {
    /// Serialises to the wire shape used by `getToolsResponse`/`toolsChanged`.
    pub fn to_wire(&self) -> Value {
        let mut v = json!({
            "name": self.tool.name,
            "description": self.tool.description,
            "origin": self.origin,
            "frameId": self.frame_id,
        });
        if let Some(title) = &self.tool.title {
            v["title"] = json!(title);
        }
        if let Some(schema) = &self.tool.input_schema {
            v["inputSchema"] = schema.clone();
        }
        if let Some(annotations) = &self.tool.annotations {
            v["annotations"] = annotations.clone();
        }
        if !self.exposed_to.is_empty() {
            v["exposedTo"] = json!(self.exposed_to);
        }
        v
    }

    /// Same-origin pages always have access; foreign pages require explicit exposure.
    pub fn is_exposed_to(&self, origin: &str) -> bool {
        self.origin == origin || self.exposed_to.iter().any(|o| o == origin)
    }
}

/// Validates a raw tool declaration value, mirroring
/// `validateToolDeclaration()` in `@webdesktopmcp/protocol`.
pub fn validate_declaration(value: &Value) -> Result<ToolDeclaration, String> {
    let Some(obj) = value.as_object() else {
        return Err("Tool must be an object.".to_string());
    };
    let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    if !is_valid_tool_name(name) {
        return Err(format!(
            "Invalid tool name: must be 1-128 characters of [A-Za-z0-9_.-], got {name:?}."
        ));
    }
    let description = obj.get("description").and_then(|v| v.as_str());
    let Some(description) = description.filter(|d| !d.is_empty()) else {
        return Err(format!(
            "Tool \"{name}\": description is required and must be a non-empty string."
        ));
    };
    let input_schema = match obj.get("inputSchema") {
        None | Some(Value::Null) => None,
        Some(schema) if schema.is_object() => {
            if !schema.get("type").and_then(|t| t.as_str()).is_some() {
                return Err(format!(
                    "Tool \"{name}\": inputSchema.type must be a string."
                ));
            }
            Some(schema.clone())
        }
        Some(_) => {
            return Err(format!(
                "Tool \"{name}\": inputSchema must be a JSON Schema object."
            ))
        }
    };
    let annotations = match obj.get("annotations") {
        None | Some(Value::Null) => None,
        Some(a) if a.is_object() => Some(a.clone()),
        Some(_) => return Err(format!("Tool \"{name}\": annotations must be an object.")),
    };
    Ok(ToolDeclaration {
        name: name.to_string(),
        title: obj
            .get("title")
            .and_then(|t| t.as_str())
            .map(|t| t.to_string()),
        description: description.to_string(),
        input_schema,
        annotations,
    })
}

/// Messages received from a webview (`RendererMessage`).
#[derive(Debug, Clone)]
pub enum RendererMessage {
    /// `register` — `tool` is left raw; validate it with [`validate_declaration`].
    Register {
        invocation_id: String,
        tool: Value,
        exposed_to: Vec<String>,
    },
    /// `unregister`
    Unregister { name: String },
    /// `executeResult`
    ExecuteResult {
        invocation_id: String,
        ok: bool,
        result: Option<String>,
        error_code: Option<String>,
        error_message: Option<String>,
    },
    /// `executeForward` — an in-page agent calling another frame's tool.
    ExecuteForward {
        request_id: String,
        name: String,
        input: Value,
    },
    /// Cancels a forwarded request owned by the sender.
    CancelForward { request_id: String },
    /// `getToolsRequest` — cross-frame tool discovery.
    GetToolsRequest {
        request_id: String,
        from_origins: Option<Vec<String>>,
    },
    /// `toolRemoved` (reserved; host-side removal is authoritative).
    ToolRemoved { name: String },
    /// `log` — debug relay from the page.
    Log { level: String, message: String },
}

/// Parses a renderer message. Returns `Err` for malformed payloads (unknown
/// kind, missing required ids) so the caller can log and drop them.
pub fn parse_renderer_message(value: &Value) -> Result<RendererMessage, String> {
    let kind = value
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or("message is missing a \"kind\" string")?;
    let str_field = |name: &str| -> Result<String, String> {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("\"{kind}\" is missing string field \"{name}\""))
    };
    let string_list = |name: &str| -> Option<Vec<String>> {
        Some(
            value
                .get(name)?
                .as_array()?
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
        )
    };
    match kind {
        "register" => Ok(RendererMessage::Register {
            invocation_id: str_field("invocationId")?,
            tool: value.get("tool").cloned().unwrap_or(Value::Null),
            exposed_to: string_list("exposedTo").unwrap_or_default(),
        }),
        "unregister" => Ok(RendererMessage::Unregister {
            name: str_field("name")?,
        }),
        "executeResult" => Ok(RendererMessage::ExecuteResult {
            invocation_id: str_field("invocationId")?,
            ok: value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            result: value
                .get("result")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            error_code: value
                .get("errorCode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            error_message: value
                .get("errorMessage")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        }),
        "executeForward" => Ok(RendererMessage::ExecuteForward {
            request_id: str_field("requestId")?,
            name: str_field("name")?,
            input: value.get("input").cloned().unwrap_or(json!({})),
        }),
        "cancelForward" => Ok(RendererMessage::CancelForward {
            request_id: str_field("requestId")?,
        }),
        "getToolsRequest" => Ok(RendererMessage::GetToolsRequest {
            request_id: str_field("requestId")?,
            from_origins: string_list("fromOrigins"),
        }),
        "toolRemoved" => Ok(RendererMessage::ToolRemoved {
            name: str_field("name")?,
        }),
        "log" => Ok(RendererMessage::Log {
            level: value
                .get("level")
                .and_then(|v| v.as_str())
                .unwrap_or("debug")
                .to_string(),
            message: value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }),
        other => Err(format!("unknown message kind \"{other}\"")),
    }
}

// ---------------------------------------------------------------------------
// Host -> page message builders
// ---------------------------------------------------------------------------

/// `registerResult`
pub fn register_result(invocation_id: &str, ok: bool, error_message: Option<&str>) -> Value {
    let mut msg = json!({ "kind": "registerResult", "invocationId": invocation_id, "ok": ok });
    if let Some(err) = error_message.filter(|_| !ok) {
        msg["errorMessage"] = json!(err);
    }
    msg
}

/// `execute`
pub fn execute_message(invocation_id: &str, name: &str, input: &Value) -> Value {
    json!({
        "kind": "execute",
        "invocationId": invocation_id,
        "name": name,
        "input": input,
    })
}

/// `abort`
pub fn abort_message(invocation_id: &str) -> Value {
    json!({ "kind": "abort", "invocationId": invocation_id })
}

/// `getToolsResponse`
pub fn get_tools_response(request_id: &str, tools: &[Value]) -> Value {
    json!({ "kind": "getToolsResponse", "requestId": request_id, "tools": tools })
}

/// `executeForwardResult`
pub fn execute_forward_result(
    request_id: &str,
    ok: bool,
    result: Option<&str>,
    error_code: Option<&str>,
    error_message: Option<&str>,
) -> Value {
    let mut msg = json!({ "kind": "executeForwardResult", "requestId": request_id, "ok": ok });
    if ok {
        msg["result"] = json!(result.unwrap_or("null"));
    } else {
        if let Some(code) = error_code {
            msg["errorCode"] = json!(code);
        }
        if let Some(err) = error_message {
            msg["errorMessage"] = json!(err);
        }
    }
    msg
}

/// `toolsChanged`
pub fn tools_changed(tools: &[Value]) -> Value {
    json!({ "kind": "toolsChanged", "tools": tools })
}

// ---------------------------------------------------------------------------
// Origin handling
// ---------------------------------------------------------------------------

/// Mirrors `normalizeOrigin()` from the protocol package: `file:` URLs keep
/// their full URL as the origin key (opaque origin); other URLs reduce to
/// `scheme://host[:port]` with default ports elided. Custom schemes
/// (`tauri://localhost`, `wry://...`) keep their host so host-stamped origins
/// match the `location.origin` pages report.
pub fn normalize_origin(url: &str) -> String {
    match Url::parse(url) {
        Ok(parsed) => {
            if parsed.scheme() == "file" {
                return url.to_string();
            }
            // Special schemes (http/https/ws/...): the url crate serialises
            // the origin exactly like `new URL(...).origin` in a page.
            let serialized = parsed.origin().ascii_serialization();
            if serialized != "null" {
                return serialized;
            }
            // Non-special scheme: WHATWG reports an opaque origin, but
            // webviews expose these pages with a real string origin.
            match parsed.host_str() {
                Some(host) if !host.is_empty() => format!(
                    "{}://{host}{}",
                    parsed.scheme(),
                    parsed.port().map(|p| format!(":{p}")).unwrap_or_default()
                ),
                _ => serialized,
            }
        }
        Err(_) => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_grammar() {
        // Valid: single char, every allowed symbol, exactly 128 chars.
        assert!(is_valid_tool_name("a"));
        assert!(is_valid_tool_name("get_weather-v2.final_1"));
        assert!(is_valid_tool_name(&"a".repeat(TOOL_NAME_MAX_LEN)));
        // Invalid: empty, over-long, and disallowed characters.
        assert!(!is_valid_tool_name(""));
        assert!(!is_valid_tool_name(&"a".repeat(TOOL_NAME_MAX_LEN + 1)));
        assert!(!is_valid_tool_name("has space"));
        assert!(!is_valid_tool_name("héllo"));
        assert!(!is_valid_tool_name("a/b"));
        assert!(!is_valid_tool_name("a:b"));
    }

    #[test]
    fn validate_declaration_accepts_and_rejects() {
        let good = json!({
            "name": "search",
            "title": "Search",
            "description": "Searches things",
            "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } },
            "annotations": { "readOnlyHint": true }
        });
        let decl = validate_declaration(&good).expect("valid declaration");
        assert_eq!(decl.name, "search");
        assert_eq!(decl.title.as_deref(), Some("Search"));

        let missing_description = json!({ "name": "search", "description": "" });
        assert!(validate_declaration(&missing_description).is_err());

        let bad_name = json!({ "name": "no spaces!", "description": "x" });
        assert!(validate_declaration(&bad_name).is_err());

        let bad_schema = json!({ "name": "x", "description": "x", "inputSchema": { "type": 42 } });
        assert!(validate_declaration(&bad_schema).is_err());
    }

    #[test]
    fn parses_renderer_messages() {
        let register = json!({
            "kind": "register",
            "invocationId": "reg-1",
            "tool": { "name": "a", "description": "d" },
            "exposedTo": ["http://localhost:3000"]
        });
        match parse_renderer_message(&register).unwrap() {
            RendererMessage::Register {
                invocation_id,
                exposed_to,
                ..
            } => {
                assert_eq!(invocation_id, "reg-1");
                assert_eq!(exposed_to, vec!["http://localhost:3000".to_string()]);
            }
            other => panic!("wrong variant: {other:?}"),
        }

        assert!(
            matches!(parse_renderer_message(&json!({"kind": "cancelForward", "requestId": "r"})).unwrap(),
            RendererMessage::CancelForward { request_id } if request_id == "r")
        );
        assert!(parse_renderer_message(&json!({"kind": "cancelForward"})).is_err());
        assert!(parse_renderer_message(&json!({"kind": "wat"})).is_err());
        assert!(parse_renderer_message(&json!({"kind": "register"})).is_err());
    }

    #[test]
    fn normalizes_origins() {
        assert_eq!(
            normalize_origin("http://localhost:3000/path?x=1"),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_origin("https://example.com"),
            "https://example.com"
        );
        // Default ports are elided, like `new URL(...).origin` in a page.
        assert_eq!(
            normalize_origin("http://example.com:80/a"),
            "http://example.com"
        );
        assert_eq!(
            normalize_origin("https://example.com:443"),
            "https://example.com"
        );
        // Custom webview schemes keep their host (matches location.origin).
        assert_eq!(normalize_origin("tauri://localhost"), "tauri://localhost");
        // file: URLs keep their full URL (matches the TS reference).
        let file = "file:///Users/me/app/index.html";
        assert_eq!(normalize_origin(file), file);
    }
}
