//! Integration test for the `~/.webdesktopmcp/registry.json` file handling.
//! Runs against an isolated fake `$HOME` so it never touches the real one.

use serde_json::Value;
use tauri_plugin_webdesktopmcp::app_registry;

#[test]
fn registry_file_round_trip() {
    let home = std::env::temp_dir().join(format!("wdm-home-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::env::set_var("HOME", &home);

    let path = home.join(".webdesktopmcp").join("registry.json");

    // Insert our entry (also prunes dead pids — there are none in a fresh file).
    app_registry::upsert_entry("TestApp", "http://127.0.0.1:54321/mcp", "secret-token")
        .expect("upsert writes the file");
    let content = std::fs::read_to_string(&path).expect("file exists");
    let value: Value = serde_json::from_str(&content).expect("valid JSON");
    let entry = &value["apps"]["TestApp"];
    assert_eq!(entry["appName"], "TestApp");
    assert_eq!(entry["url"], "http://127.0.0.1:54321/mcp");
    assert_eq!(entry["token"], "secret-token");
    assert_eq!(entry["pid"], std::process::id());
    assert_eq!(entry["protocolVersion"], 1);
    assert!(entry["updatedAt"].as_str().is_some());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "file must be 0600");
    }

    // Removal leaves the rest of the document intact.
    app_registry::upsert_entry("OtherApp", "http://127.0.0.1:54322/mcp", "t2").unwrap();
    app_registry::remove_entry("TestApp");
    let content = std::fs::read_to_string(&path).unwrap();
    let value: Value = serde_json::from_str(&content).unwrap();
    assert!(value["apps"].get("TestApp").is_none());
    assert_eq!(value["apps"]["OtherApp"]["appName"], "OtherApp");

    let _ = std::fs::remove_dir_all(&home);
}
