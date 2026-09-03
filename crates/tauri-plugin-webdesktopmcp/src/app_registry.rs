//! App registry file: `~/.webdesktopmcp/registry.json` (protocol.md §7).
//!
//! Each running app lists its loopback MCP endpoint + bearer token here so
//! stdio shims and CLIs can discover it. Writes are atomic (tmp + rename)
//! with `0600` permissions on unix. Entries of dead processes are pruned on
//! write (best-effort via `kill -0` on unix; no-op elsewhere).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// `<home>/.webdesktopmcp/registry.json`, or `None` if the home dir is unknown.
pub fn registry_file() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".webdesktopmcp").join("registry.json"))
}

/// Inserts/updates this app's entry, pruning dead processes first.
pub fn upsert_entry(app_name: &str, url: &str, token: &str) -> std::io::Result<()> {
    let Some(path) = registry_file() else {
        return Err(std::io::Error::other("home directory not found"));
    };
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("registry path has no parent"))?;
    fs::create_dir_all(dir)?;
    set_mode(dir, 0o700);

    let mut root = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));

    // Existing `apps` map (preserved verbatim apart from pruning + our entry).
    let mut apps: HashMap<String, Value> = root
        .get("apps")
        .and_then(|a| a.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    let current_pid = std::process::id();
    apps.retain(|_, entry| match entry.get("pid").and_then(|p| p.as_u64()) {
        Some(pid) => pid == current_pid as u64 || is_alive(pid),
        None => true, // malformed entry — leave it alone
    });

    apps.insert(
        app_name.to_string(),
        json!({
            "appName": app_name,
            "url": url,
            "token": token,
            "pid": current_pid,
            "protocolVersion": 1,
            "updatedAt": iso_now(),
        }),
    );

    root["apps"] = Value::Object(apps.into_iter().collect());
    write_atomic(&path, &root.to_string())
}

/// Removes this app's entry (best-effort; called on plugin drop).
pub fn remove_entry(app_name: &str) {
    let Some(path) = registry_file() else {
        return;
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(apps) = root.get_mut("apps").and_then(|a| a.as_object_mut()) else {
        return;
    };
    if apps.remove(app_name).is_none() {
        return;
    }
    if let Err(err) = write_atomic(&path, &root.to_string()) {
        eprintln!("[webdesktopmcp] failed to update {}: {err}", path.display());
    }
}

fn write_atomic(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::other("registry path has no parent")
    })?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("registry.json"),
        std::process::id()
    ));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all().ok();
    }
    set_mode(&tmp, 0o600);
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

#[cfg(unix)]
fn set_mode(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &std::path::Path, _mode: u32) {}

/// Best-effort liveness probe. On unix we shell out to `kill -0` (no extra
/// dependency); a spawn failure conservatively reports "alive" so entries are
/// not pruned by tooling problems. Non-unix platforms keep all entries.
fn is_alive(pid: u64) -> bool {
    #[cfg(unix)]
    {
        let pid = pid.to_string();
        let probe = |program: &str| {
            Command::new(program)
                .arg("-0")
                .arg(&pid)
                .output()
                .ok()
                .map(|output| output.status.success())
        };
        probe("/bin/kill").or_else(|| probe("kill")).unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Current UTC time as ISO 8601 with millisecond precision, std-only.
fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 -> (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamp_format() {
        // Known anchors: epoch day 0, the 2024 leap day, and 2026-09-03.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(20_699), (2026, 9, 3));
        // iso_now() produces a plausible, parseable shape.
        let stamp = iso_now();
        assert_eq!(stamp.len(), 24);
        assert!(stamp.ends_with('Z'));
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
    }
}
