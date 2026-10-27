//! Small JSON stores in the data folder: settings, recent scans, history.
use serde_json::{Map, Value, json};
use std::path::Path;

pub fn read_json(file: &Path, fallback: Value) -> Value {
    std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

pub fn write_json(file: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value).unwrap_or_default())?;
    std::fs::rename(tmp, file)
}

fn defaults(version: &str) -> Value {
    json!({
        // "auto" follows the system language; otherwise a code from src/renderer/lib/i18n.js
        "language": "auto",
        "accent": "#C6F432",
        "shading": true,
        "scan": { "mft": true, "hidden": true, "links": false },
        "view": "treemap",
        // check: null until the person was asked; Strata never contacts the network before they say yes.
        "updates": { "check": null, "channel": if version.contains('-') { "beta" } else { "stable" }, "lastCheck": 0, "skipped": "" },
        "lastSeenVersion": ""
    })
}

fn merge_into(base: &mut Value, over: &Value) {
    if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            match b.get_mut(k) {
                Some(slot) if slot.is_object() && v.is_object() => merge_into(slot, v),
                _ => {
                    b.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

/// Saved settings over the defaults, so settings from older versions keep working.
pub fn get_settings(file: &Path, version: &str) -> Value {
    let mut s = defaults(version);
    merge_into(&mut s, &read_json(file, Value::Object(Map::new())));
    s
}

pub fn set_settings(file: &Path, version: &str, patch: &Value) -> Value {
    let mut s = get_settings(file, version);
    merge_into(&mut s, patch);
    let _ = write_json(file, &s);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_merge_over_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("settings.json");
        write_json(&f, &json!({"accent": "#fff", "scan": {"mft": false}})).unwrap();
        let s = get_settings(&f, "0.2.0");
        assert_eq!(s["accent"], "#fff");
        assert_eq!(s["scan"]["mft"], false);
        assert_eq!(s["scan"]["hidden"], true);
        assert_eq!(s["updates"]["channel"], "stable");
        assert_eq!(s["updates"]["check"], Value::Null);
        let s = set_settings(&f, "0.2.0-beta.1", &json!({"updates": {"check": true}}));
        assert_eq!(s["updates"]["check"], true);
        assert_eq!(s["updates"]["channel"], "beta");
        assert_eq!(get_settings(&f, "0.2.0")["updates"]["check"], true);
    }
}
