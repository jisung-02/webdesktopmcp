//! Plugin configuration.

use serde::{Deserialize, Serialize};

/// Configuration for the webdesktopmcp plugin.
///
/// `app_name`/`app_version` become the MCP `serverInfo` identity reported to
/// external clients and the key under which this app is listed in
/// `~/.webdesktopmcp/registry.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebDesktopMcpConfig {
    /// User-facing app name (also the registry-file lookup key).
    pub app_name: String,
    /// App version reported in `initialize` responses.
    pub app_version: String,
    /// Port to bind the loopback MCP server on. `None` picks an ephemeral port.
    pub port: Option<u16>,
}

impl Default for WebDesktopMcpConfig {
    fn default() -> Self {
        Self {
            app_name: "Tauri App".to_string(),
            app_version: "0.0.0".to_string(),
            port: None,
        }
    }
}

impl WebDesktopMcpConfig {
    /// Creates a config with the given app identity and an ephemeral port.
    pub fn new(app_name: impl Into<String>, app_version: impl Into<String>) -> Self {
        Self {
            app_name: app_name.into(),
            app_version: app_version.into(),
            port: None,
        }
    }

    /// Overrides the user-facing app name.
    pub fn with_app_name(mut self, app_name: impl Into<String>) -> Self {
        self.app_name = app_name.into();
        self
    }

    /// Overrides the reported app version.
    pub fn with_app_version(mut self, app_version: impl Into<String>) -> Self {
        self.app_version = app_version.into();
        self
    }

    /// Pins the loopback MCP server to a fixed port instead of an ephemeral one.
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }
}
