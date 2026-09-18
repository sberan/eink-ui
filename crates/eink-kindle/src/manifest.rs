//! The device's settings come from the repository's `package.json`: `main` names the app it
//! runs and the `eink` section holds display, clock, ssh, power and the app's own keys. That
//! file is read-only on the device. What is changed from the device (`:light`, `:theme`, `:ssh`,
//! `:set`) goes to `data/settings.json`, merged over the `eink` section key by key, because
//! `data/` is the only folder the device writes: it can never corrupt the app it runs.
use crate::log;
use crate::repo::{self, REPO};
use serde_json::{json, Value};
use std::fs;

pub const PACKAGE: &str = "package.json";
pub const OVERRIDES: &str = "data/settings.json";
const DEFAULT_ENTRY: &str = "dist/app.js";

/// The only place the device writes: the app's data and its own setting changes.
pub fn is_writable(rel: &str) -> bool {
    rel.starts_with("data/") && !rel.split('/').any(|s| s == "..")
}

fn read_object(rel: &str) -> Value {
    match fs::read_to_string(format!("{REPO}/{rel}")) {
        Ok(text) => parse(&text).unwrap_or_else(|e| {
            log(&format!("{rel}: {e}; ignored"));
            json!({})
        }),
        Err(_) => json!({}),
    }
}

pub fn parse(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if v.is_object() { Ok(v) } else { Err("must be a JSON object".into()) }
}

/// `main` of package.json: the bundle the device runs, relative to the repository.
pub fn app_entry() -> String {
    read_object(PACKAGE)
        .get("main")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && is_safe(s))
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_ENTRY.to_string())
}

fn is_safe(rel: &str) -> bool {
    !rel.starts_with('/') && !rel.split('/').any(|s| s == "..")
}

/// Objects merge key by key, anything else on the right replaces the left.
pub fn merge(mut base: Value, over: Value) -> Value {
    match (base.as_object_mut(), over) {
        (Some(b), Value::Object(o)) => {
            for (k, v) in o {
                match b.get_mut(&k) {
                    Some(bv) if bv.is_object() && v.is_object() => {
                        let merged = merge(bv.take(), v);
                        *bv = merged;
                    }
                    _ => {
                        b.insert(k, v);
                    }
                }
            }
            base
        }
        (_, over) => over,
    }
}

/// The settings in force: package.json's `eink` section under data/settings.json.
pub fn read() -> Value {
    let base = read_object(PACKAGE).get("eink").cloned().filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
    merge(base, read_object(OVERRIDES))
}

pub fn get(path: &[&str]) -> Option<Value> {
    let root = read();
    let mut cur = &root;
    for k in path {
        cur = cur.get(*k)?;
    }
    Some(cur.clone())
}

pub fn string(path: &[&str], default: &str) -> String {
    get(path).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| default.to_string())
}

pub fn number(path: &[&str], default: u32) -> u32 {
    get(path).and_then(|v| v.as_u64()).map_or(default, |n| n.min(u32::MAX as u64) as u32)
}

pub fn flag(path: &[&str], default: bool) -> bool {
    get(path).and_then(|v| v.as_bool()).unwrap_or(default)
}

pub fn list(path: &[&str]) -> Option<Vec<String>> {
    get(path)?.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
}

/// One setting written into data/settings.json, pretty-printed, and handed to the repository
/// worker, which commits it a few seconds later like any other write.
pub fn set(path: &[&str], value: Value) -> Result<String, String> {
    let Some((last, parents)) = path.split_last() else { return Err("empty setting name".into()) };
    let mut root = read_object(OVERRIDES);
    let text = {
        let mut cur = &mut root;
        for k in parents {
            if !cur.get(*k).is_some_and(|v| v.is_object()) {
                cur[*k] = json!({});
            }
            cur = cur.get_mut(*k).ok_or("settings path")?;
        }
        cur[*last] = value.clone();
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n"
    };
    // written here, so the caller can read the new value at once; the worker commits it
    let full = format!("{REPO}/{OVERRIDES}");
    if let Some(dir) = std::path::Path::new(&full).parent() {
        let _ = fs::create_dir_all(dir);
    }
    fs::write(&full, &text).map_err(|e| format!("{OVERRIDES}: {e}"))?;
    let cmd = crate::REPO_CMD.lock().ok().and_then(|g| g.clone()).ok_or("the repository worker is not running")?;
    cmd.send(repo::SyncCmd::Commit(OVERRIDES.to_string())).map_err(|e| e.to_string())?;
    Ok(format!("{} = {value} (in {OVERRIDES}, committed with the next push)", path.join(".")))
}

/// `:set a.b.c=value`: JSON when it parses (numbers, booleans, null, arrays, objects), else a string.
pub fn set_from_text(dotted: &str, raw: &str) -> Result<String, String> {
    let path: Vec<&str> = dotted.split('.').filter(|s| !s.is_empty()).collect();
    let value = serde_json::from_str::<Value>(raw.trim()).unwrap_or_else(|_| Value::String(raw.trim().to_string()));
    set(&path, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_merge_key_by_key() {
        let base = json!({"display": {"theme": "light", "frontlight": "auto"}, "ssh": {"enabled": true}});
        let over = json!({"display": {"frontlight": "dark"}, "clock": {"tz": "UTC0"}});
        let m = merge(base, over);
        assert_eq!(m["display"]["theme"], "light");
        assert_eq!(m["display"]["frontlight"], "dark");
        assert_eq!(m["ssh"]["enabled"], true);
        assert_eq!(m["clock"]["tz"], "UTC0");
        assert_eq!(merge(json!({"a": 1}), json!({"a": {"b": 2}}))["a"]["b"], 2);
    }

    #[test]
    fn only_data_is_writable() {
        assert!(is_writable("data/2026-09-17.md"));
        assert!(is_writable("data/settings.json"));
        assert!(!is_writable("package.json"));
        assert!(!is_writable("dist/app.js"));
        assert!(!is_writable("data/../package.json"));
        assert!(!is_writable("datafile"));
    }

    #[test]
    fn only_objects_are_settings() {
        assert!(parse("{\"eink\": {}}").is_ok());
        assert!(parse("[1, 2]").is_err());
        assert!(parse("nope").is_err());
    }
}
