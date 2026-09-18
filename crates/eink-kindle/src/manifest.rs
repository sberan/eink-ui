//! `manifest.json` at the root of the synced repository holds every setting of the device that
//! is not an address or a secret (those stay in keys.conf): `display`, `clock`, `ssh`, `power`,
//! and whatever the app keeps under `app`. It is read on start and after every pull. The debug
//! port's setters write it back through the repository worker, so a change made on the device
//! is committed like a tick, and a change committed by anyone else applies at the next pull.
use crate::log;
use crate::repo::{self, REPO};
use serde_json::{json, Value};
use std::fs;

pub const FILE: &str = "manifest.json";

/// The manifest as an object; `{}` when the file is missing or broken (which is logged).
pub fn read() -> Value {
    match fs::read_to_string(format!("{REPO}/{FILE}")) {
        Ok(text) => parse(&text).unwrap_or_else(|e| {
            log(&format!("{FILE}: {e}; using defaults"));
            json!({})
        }),
        Err(_) => json!({}),
    }
}

pub fn parse(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if v.is_object() { Ok(v) } else { Err("the manifest must be a JSON object".into()) }
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

/// One setting written into the file, pretty-printed, and handed to the repository worker,
/// which commits it a few seconds later like any other write.
pub fn set(path: &[&str], value: Value) -> Result<String, String> {
    let Some((last, parents)) = path.split_last() else { return Err("empty setting name".into()) };
    let mut root = read();
    let text = {
        let mut cur = &mut root;
        for k in parents {
            if !cur.get(*k).is_some_and(|v| v.is_object()) {
                cur[*k] = json!({});
            }
            cur = cur.get_mut(*k).ok_or("manifest path")?;
        }
        cur[*last] = value.clone();
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n"
    };
    // written here, so the caller can read the new value at once; the worker commits it
    fs::write(format!("{REPO}/{FILE}"), &text).map_err(|e| format!("{FILE}: {e}"))?;
    let cmd = crate::REPO_CMD.lock().ok().and_then(|g| g.clone()).ok_or("the repository worker is not running")?;
    cmd.send(repo::SyncCmd::Commit(FILE.to_string())).map_err(|e| e.to_string())?;
    Ok(format!("{} = {value} (committed with the next push)", path.join(".")))
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
    fn only_objects_are_manifests() {
        assert!(parse("{\"display\": {\"theme\": \"dark\"}}").is_ok());
        assert!(parse("[1, 2]").is_err());
        assert!(parse("nope").is_err());
    }

    #[test]
    fn values_parse_as_json_then_string() {
        let as_value = |raw: &str| serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
        assert_eq!(as_value("15"), json!(15));
        assert_eq!(as_value("true"), json!(true));
        assert_eq!(as_value("[\"a\", \"b\"]"), json!(["a", "b"]));
        assert_eq!(as_value("America/Chicago"), json!("America/Chicago"));
        assert_eq!(as_value("dark"), json!("dark"));
    }
}
