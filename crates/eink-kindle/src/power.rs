//! Power policy: `manifest.json` at the root of the synced repository lists stages the device
//! moves through as time passes without interaction, each naming the functions that stay on.
//! A stage with `suspend` sleeps the device, waking every `wake_every_minutes` to pull.
//!
//! ```json
//! { "power": { "stages": [
//!   { "name": "on",        "minutes": 10, "functions": ["frontlight", "cpu", "wifi", "sync", "haptics"] },
//!   { "name": "low power", "minutes": 50, "functions": ["wifi", "sync"] },
//!   { "name": "sleep",     "suspend": true, "wake_every_minutes": 30 }
//! ] } }
//! ```
use crate::{frontlight_apply, lipc_set, log};
use std::{
    fs,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::Mutex,
    time::Duration,
};

/// What the host can switch. Touch, the panel and the debug port are never switched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Functions {
    pub frontlight: bool,
    pub cpu: bool,
    pub wifi: bool,
    pub sync: bool,
    pub haptics: bool,
}

pub const ALL_ON: Functions = Functions { frontlight: true, cpu: true, wifi: true, sync: true, haptics: true };
pub const ALL_OFF: Functions = Functions { frontlight: false, cpu: false, wifi: false, sync: false, haptics: false };
const NAMES: [&str; 5] = ["frontlight", "cpu", "wifi", "sync", "haptics"];

#[derive(Clone, Debug, PartialEq)]
pub struct Stage {
    pub name: String,
    /// How long the stage lasts without interaction; the last stage lasts until interaction.
    pub minutes: Option<f64>,
    pub functions: Functions,
    pub suspend: bool,
    pub wake_every: Duration,
}

const DEFAULT_WAKE: Duration = Duration::from_secs(30 * 60);
const MIN_WAKE: Duration = Duration::from_secs(60);

pub static HAPTICS: AtomicBool = AtomicBool::new(true);
pub static SYNC: AtomicBool = AtomicBool::new(true);
/// For `:power`: the stage in force and the time without interaction.
pub static STAGE: Mutex<String> = Mutex::new(String::new());
pub static IDLE_SECS: AtomicU64 = AtomicU64::new(0);

const CPUFREQ: &str = "/sys/devices/system/cpu/cpu0/cpufreq";

pub fn defaults() -> Vec<Stage> {
    vec![
        Stage { name: "on".into(), minutes: Some(10.0), functions: ALL_ON, suspend: false, wake_every: DEFAULT_WAKE },
        Stage {
            name: "low power".into(),
            minutes: Some(50.0),
            functions: Functions { frontlight: false, cpu: false, wifi: true, sync: true, haptics: false },
            suspend: false,
            wake_every: DEFAULT_WAKE,
        },
        Stage { name: "sleep".into(), minutes: None, functions: ALL_OFF, suspend: true, wake_every: DEFAULT_WAKE },
    ]
}

/// The policy in `manifest.json`, or the defaults when the file is missing or broken.
pub fn load(repo: &str) -> Vec<Stage> {
    let path = format!("{repo}/manifest.json");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return defaults(),
    };
    match parse(&text) {
        Ok(Some(stages)) => stages,
        Ok(None) => defaults(),
        Err(e) => {
            log(&format!("manifest.json: {e}; using the default power policy"));
            defaults()
        }
    }
}

/// `Ok(None)` when the manifest has no power section.
pub fn parse(text: &str) -> Result<Option<Vec<Stage>>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let Some(list) = v.get("power").and_then(|p| p.get("stages")) else { return Ok(None) };
    let list = list.as_array().ok_or("power.stages must be a list")?;
    if list.is_empty() {
        return Err("power.stages is empty".into());
    }
    let mut stages = Vec::new();
    for (i, s) in list.iter().enumerate() {
        let name = s.get("name").and_then(|n| n.as_str()).map(str::to_string).unwrap_or_else(|| format!("stage {}", i + 1));
        let suspend = s.get("suspend").and_then(|b| b.as_bool()).unwrap_or(false);
        let minutes = match s.get("minutes") {
            None => None,
            Some(m) => Some(m.as_f64().filter(|m| m.is_finite() && *m >= 0.0).ok_or_else(|| format!("stage '{name}': minutes must be a number"))?),
        };
        let mut functions = if suspend { ALL_OFF } else { ALL_ON };
        if let Some(list) = s.get("functions") {
            let list = list.as_array().ok_or_else(|| format!("stage '{name}': functions must be a list"))?;
            functions = ALL_OFF;
            for f in list {
                match f.as_str() {
                    Some("frontlight") => functions.frontlight = true,
                    Some("cpu") => functions.cpu = true,
                    Some("wifi") => functions.wifi = true,
                    Some("sync") => functions.sync = true,
                    Some("haptics") => functions.haptics = true,
                    other => log(&format!("manifest.json: stage '{name}' names an unknown function {other:?}; known: {}", NAMES.join(", "))),
                }
            }
        }
        let wake_every = s
            .get("wake_every_minutes")
            .and_then(|m| m.as_f64())
            .filter(|m| m.is_finite() && *m > 0.0)
            .map(|m| Duration::from_secs_f64(m * 60.0).max(MIN_WAKE))
            .unwrap_or(DEFAULT_WAKE);
        stages.push(Stage { name, minutes, functions, suspend, wake_every });
        if minutes.is_none() && i + 1 < list.len() {
            log(&format!("manifest.json: stage '{}' has no minutes, so the stages after it are never reached", stages.last().map(|s| s.name.as_str()).unwrap_or("")));
            break;
        }
    }
    Ok(Some(stages))
}

/// Index of the stage in force after `idle` without interaction.
pub fn stage_at(stages: &[Stage], idle: Duration) -> usize {
    let idle_min = idle.as_secs_f64() / 60.0;
    let mut start = 0.0;
    let mut at = 0;
    for (i, s) in stages.iter().enumerate() {
        if idle_min >= start {
            at = i;
        }
        match s.minutes {
            Some(m) => start += m,
            None => break,
        }
    }
    at
}

pub fn describe(stages: &[Stage]) -> String {
    stages
        .iter()
        .map(|s| {
            let on: Vec<&str> = NAMES.iter().copied().filter(|n| has(&s.functions, n)).collect();
            let span = s.minutes.map(|m| format!("{m:.0} min")).unwrap_or_else(|| "until interaction".into());
            if s.suspend {
                format!("{} ({span}, suspend, wake every {} min)", s.name, s.wake_every.as_secs() / 60)
            } else {
                format!("{} ({span}: {})", s.name, if on.is_empty() { "nothing on".into() } else { on.join(" ") })
            }
        })
        .collect::<Vec<_>>()
        .join(" -> ")
}

fn has(f: &Functions, name: &str) -> bool {
    match name {
        "frontlight" => f.frontlight,
        "cpu" => f.cpu,
        "wifi" => f.wifi,
        "sync" => f.sync,
        "haptics" => f.haptics,
        _ => false,
    }
}

/// Switches what differs between `from` and `to`. `governor` remembers the CPU governor across
/// a stage with the CPU slowed down.
pub fn apply(from: Functions, to: Functions, governor: &mut Option<String>) {
    if from.frontlight != to.frontlight {
        frontlight_apply(to.frontlight);
    }
    if from.cpu != to.cpu {
        if to.cpu {
            if let Some(g) = governor.take() {
                let _ = fs::write(format!("{CPUFREQ}/scaling_governor"), format!("{g}\n"));
            }
        } else {
            if let Ok(g) = fs::read_to_string(format!("{CPUFREQ}/scaling_governor")) {
                *governor = Some(g.trim().to_string());
            }
            let _ = fs::write(format!("{CPUFREQ}/scaling_governor"), "userspace\n");
            if let Ok(min) = fs::read_to_string(format!("{CPUFREQ}/cpuinfo_min_freq")) {
                let _ = fs::write(format!("{CPUFREQ}/scaling_setspeed"), min);
            }
        }
    }
    if from.wifi != to.wifi {
        lipc_set("com.lab126.wifid", "enable", if to.wifi { "1" } else { "0" });
    }
    if from.sync != to.sync {
        SYNC.store(to.sync, Ordering::SeqCst);
    }
    if from.haptics != to.haptics {
        HAPTICS.store(to.haptics, Ordering::SeqCst);
    }
}

pub fn note_stage(name: &str, idle: Duration) {
    if let Ok(mut g) = STAGE.lock() {
        *g = name.to_string();
    }
    IDLE_SECS.store(idle.as_secs(), Ordering::Relaxed);
}

pub fn status(stages: &[Stage]) -> String {
    let stage = STAGE.lock().map(|g| g.clone()).unwrap_or_default();
    let idle = IDLE_SECS.load(Ordering::Relaxed);
    format!("power: stage '{stage}', {} min {} s without interaction; policy: {}", idle / 60, idle % 60, describe(stages))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_spec() {
        let s = defaults();
        assert_eq!(stage_at(&s, Duration::from_secs(0)), 0);
        assert_eq!(stage_at(&s, Duration::from_secs(9 * 60)), 0);
        assert_eq!(stage_at(&s, Duration::from_secs(10 * 60)), 1);
        assert_eq!(stage_at(&s, Duration::from_secs(59 * 60)), 1);
        assert_eq!(stage_at(&s, Duration::from_secs(60 * 60)), 2);
        assert!(s[2].suspend);
        assert_eq!(s[2].wake_every, Duration::from_secs(1800));
        assert_eq!(s[1].functions, Functions { frontlight: false, cpu: false, wifi: true, sync: true, haptics: false });
    }

    #[test]
    fn manifest_stages_are_parsed() {
        let text = r#"{ "power": { "stages": [
            { "name": "on", "minutes": 2, "functions": ["frontlight", "cpu", "wifi", "sync", "haptics"] },
            { "name": "dim", "minutes": 3, "functions": ["wifi", "sync", "bogus"] },
            { "name": "sleep", "suspend": true, "wake_every_minutes": 5 }
        ] } }"#;
        let s = parse(text).unwrap().unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s[1].functions, Functions { frontlight: false, cpu: false, wifi: true, sync: true, haptics: false });
        assert_eq!(s[2].wake_every, Duration::from_secs(300));
        assert_eq!(stage_at(&s, Duration::from_secs(4 * 60)), 1);
        assert_eq!(stage_at(&s, Duration::from_secs(5 * 60)), 2);
        assert_eq!(describe(&s), "on (2 min: frontlight cpu wifi sync haptics) -> dim (3 min: wifi sync) -> sleep (until interaction, suspend, wake every 5 min)");
    }

    #[test]
    fn missing_or_broken_manifests_fall_back() {
        assert_eq!(parse(r#"{ "app": "reader" }"#).unwrap(), None);
        assert!(parse("not json").is_err());
        assert!(parse(r#"{ "power": { "stages": [] } }"#).is_err());
        assert!(parse(r#"{ "power": { "stages": [ { "minutes": "soon" } ] } }"#).is_err());
    }

    #[test]
    fn a_stage_without_minutes_ends_the_list() {
        let s = parse(r#"{ "power": { "stages": [ { "name": "always on" }, { "name": "never", "suspend": true } ] } }"#).unwrap().unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].functions, ALL_ON);
        assert_eq!(stage_at(&s, Duration::from_secs(100_000)), 0);
    }
}
