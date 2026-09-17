//! eink-host: runs the React bundle in QuickJS against eink-core, paints damage rects through
//! FBInk region updates, feeds touch/PagePress input, and applies the todo app's power policy.
//! Static state = blocked on the input channel; JS only runs on events and timers.
mod epdc;
mod gh;
mod input;
mod repo;

use anyhow::{Context, Result};
use eink_core::{Damage, Kind, Mode, Scene};
use rquickjs::{function::{Opt, Rest}, Context as JsContext, Function, Object, Runtime, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    process::Command,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

pub const DIR: &str = "/mnt/us/todo-app";

/// Debug commands reach the repository worker through this.
static REPO_CMD: std::sync::Mutex<Option<mpsc::Sender<repo::SyncCmd>>> = std::sync::Mutex::new(None);
/// Debug commands inject synthetic input through this.
static MAIN_TX: std::sync::Mutex<Option<mpsc::Sender<Event>>> = std::sync::Mutex::new(None);
/// Dark mode: every pixel is inverted on its way to the panel, so components stay black on white.
static INVERT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Events slower than this many milliseconds are logged with a breakdown (`:slow <ms>`).
static SLOW_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(80);
const WORK: &str = "/var/tmp/todo-app";
const IDLE_AFTER: Duration = Duration::from_secs(180);
const FRONTLIGHT: &str = "/sys/class/backlight/max77696-bl/brightness";
const HAPTIC: &str = "/sys/devices/system/drv26xx_haptics/drv26xx_haptics0/play_waveform";
const AMBIENT: &str = "/sys/devices/system/max44009_ctrl/max44009_ctrl0/max44009_lux";
const FRONTLIGHT_MAX: u32 = 4095;
const LIGHT_TICK: Duration = Duration::from_secs(20);

/// Ambient light in lux from the Voyage's MAX44009, if the sensor answers.
fn ambient_lux() -> Option<u32> {
    fs::read_to_string(AMBIENT).ok().and_then(|s| s.trim().parse().ok())
}

/// Frontlight level for an ambient reading: nothing in daylight or a bright room, more as the
/// room gets darker, capped well below the maximum, which is painful in the dark.
fn light_for(lux: u32) -> u32 {
    // calibrated against the Voyage's own scale: a bright room reads about 1300 here
    match lux {
        l if l >= 6000 => 0,
        l if l >= 2500 => 700,
        l if l >= 900 => 1500,
        l if l >= 300 => 1900,
        l if l >= 100 => 2300,
        l if l >= 30 => 2600,
        _ => 2900,
    }
}

/// `frontlight=` in keys.conf: `auto` (default), `off`, or a fixed 0..4095.
fn frontlight_setting() -> String {
    fs::read_to_string(format!("{DIR}/keys.conf")).ok()
        .and_then(|s| s.lines().find_map(|l| l.trim().strip_prefix("frontlight=").map(|v| v.trim().to_string())))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "auto".into())
}

fn set_frontlight(level: u32) {
    let _ = fs::write(FRONTLIGHT, format!("{}\n", level.min(FRONTLIGHT_MAX)));
}

/// One auto-brightness step: hysteresis so a flickering room does not flicker the light, and a
/// bounded ramp so a change is never a jump. Returns the level written, if any.
fn auto_light_step(current: &mut u32) -> Option<u32> {
    if frontlight_setting() != "auto" {
        return None;
    }
    let lux = ambient_lux()?;
    let target = light_for(lux);
    let diff = target.abs_diff(*current);
    if diff < 120 {
        return None;
    }
    let step = diff.min(400);
    let next = if target > *current { *current + step } else { *current - step };
    *current = next;
    set_frontlight(next);
    Some(next)
}

pub enum Event {
    Tap(i32, i32),
    Key(u16),
    Power(String),
    Eval(String, mpsc::Sender<String>),
    /// Five quick power-button presses: restart, which refetches the bundle.
    Reload,
    /// A background manifest sync finished (or failed with the message).
    Synced(Result<SyncOutcome, String>),
    /// An async fetch finished: promise id, then Ok(JSON {status, headers, body}) or Err(message).
    FetchDone(u32, Result<String, String>),
    /// Repaint the whole panel (theme change).
    Repaint,
    /// A repository pull changed these paths.
    Files(Vec<String>),
    /// The repository worker's state changed.
    SyncState(repo::SyncState),
}

#[derive(Default, Debug)]
pub struct SyncOutcome {
    pub changed: Vec<String>,
    pub removed: Vec<String>,
    pub app_changed: bool,
    pub host_changed: bool,
}

static DEBUG_CLIENTS: std::sync::Mutex<Vec<std::net::TcpStream>> = std::sync::Mutex::new(Vec::new());
static LAST_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

const BADGE: u32 = 36; // error badge: black rounded square with a white "!" in the top-right corner
const BADGE_X: u32 = 1072 - BADGE - 16;
const BADGE_Y: u32 = 14;

fn set_error(fb: &mut epdc::Epdc, msg: &str) {
    log(&format!("ERROR: {msg}"));
    if let Ok(mut e) = LAST_ERROR.lock() {
        *e = Some(msg.to_string());
    }
    draw_badge(fb);
}

fn clear_error() {
    if let Ok(mut e) = LAST_ERROR.lock() {
        *e = None;
    }
}

fn has_error() -> bool {
    LAST_ERROR.lock().map(|e| e.is_some()).unwrap_or(false)
}

fn draw_badge(fb: &mut epdc::Epdc) {
    let n = BADGE as usize;
    let mut px = vec![0u8; n * n];
    let r = 6i32;
    for y in 0..n as i32 {
        for x in 0..n as i32 {
            // rounded corners
            let dx = if x < r { r - x } else if x >= n as i32 - r { x - (n as i32 - r - 1) } else { 0 };
            let dy = if y < r { r - y } else if y >= n as i32 - r { y - (n as i32 - r - 1) } else { 0 };
            if dx > 0 && dy > 0 && dx * dx + dy * dy > r * r {
                px[(y * n as i32 + x) as usize] = 255;
            }
            // exclamation mark: bar + dot
            let bar = (14..22).contains(&x) && (6..22).contains(&y);
            let dot = (14..22).contains(&x) && (25..31).contains(&y);
            if bar || dot {
                px[(y * n as i32 + x) as usize] = 255;
            }
        }
    }
    let _ = fb.blit_gray(&px, BADGE, BADGE, BADGE_X, BADGE_Y);
    let _ = fb.refresh(BADGE_X, BADGE_Y, BADGE, BADGE, epdc::WAVEFORM_DU, false, false);
}

/// Zone names the stock firmware may record, with POSIX rules (the device has no zoneinfo).
const ZONES: &[(&str, &str)] = &[
    ("America/New_York", "EST5EDT,M3.2.0,M11.1.0"), ("America/Detroit", "EST5EDT,M3.2.0,M11.1.0"), ("America/Toronto", "EST5EDT,M3.2.0,M11.1.0"),
    ("America/Chicago", "CST6CDT,M3.2.0,M11.1.0"), ("America/Winnipeg", "CST6CDT,M3.2.0,M11.1.0"), ("America/Mexico_City", "CST6"),
    ("America/Denver", "MST7MDT,M3.2.0,M11.1.0"), ("America/Edmonton", "MST7MDT,M3.2.0,M11.1.0"), ("America/Phoenix", "MST7"),
    ("America/Los_Angeles", "PST8PDT,M3.2.0,M11.1.0"), ("America/Vancouver", "PST8PDT,M3.2.0,M11.1.0"), ("America/Anchorage", "AKST9AKDT,M3.2.0,M11.1.0"),
    ("Pacific/Honolulu", "HST10"), ("America/Sao_Paulo", "<-03>3"), ("America/Argentina/Buenos_Aires", "<-03>3"), ("America/Bogota", "<-05>5"),
    ("Europe/London", "GMT0BST,M3.5.0/1,M10.5.0"), ("Europe/Dublin", "GMT0IST,M3.5.0/1,M10.5.0"), ("Europe/Lisbon", "WET0WEST,M3.5.0/1,M10.5.0"),
    ("Europe/Paris", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Berlin", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Madrid", "CET-1CEST,M3.5.0,M10.5.0/3"),
    ("Europe/Rome", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Amsterdam", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Brussels", "CET-1CEST,M3.5.0,M10.5.0/3"),
    ("Europe/Vienna", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Zurich", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Stockholm", "CET-1CEST,M3.5.0,M10.5.0/3"),
    ("Europe/Oslo", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Copenhagen", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Prague", "CET-1CEST,M3.5.0,M10.5.0/3"),
    ("Europe/Warsaw", "CET-1CEST,M3.5.0,M10.5.0/3"), ("Europe/Athens", "EET-2EEST,M3.5.0/3,M10.5.0/4"), ("Europe/Helsinki", "EET-2EEST,M3.5.0/3,M10.5.0/4"),
    ("Europe/Kiev", "EET-2EEST,M3.5.0/3,M10.5.0/4"), ("Europe/Bucharest", "EET-2EEST,M3.5.0/3,M10.5.0/4"), ("Europe/Istanbul", "<+03>-3"), ("Europe/Moscow", "MSK-3"),
    ("Asia/Dubai", "<+04>-4"), ("Asia/Kolkata", "IST-5:30"), ("Asia/Singapore", "<+08>-8"), ("Asia/Hong_Kong", "HKT-8"), ("Asia/Shanghai", "CST-8"),
    ("Asia/Tokyo", "JST-9"), ("Asia/Seoul", "KST-9"), ("Australia/Sydney", "AEST-10AEDT,M10.1.0,M4.1.0/3"), ("Australia/Melbourne", "AEST-10AEDT,M10.1.0,M4.1.0/3"),
    ("Australia/Brisbane", "AEST-10"), ("Australia/Perth", "AWST-8"), ("Pacific/Auckland", "NZST-12NZDT,M9.5.0,M4.1.0/3"), ("UTC", "UTC0"),
];

/// The local zone as a POSIX TZ string and where it came from: `tz=` in keys.conf, else a zone
/// name the stock firmware cached, else the plain offset it keeps in tzVar (no daylight rule).
fn detect_tz() -> Option<(String, &'static str)> {
    if let Some(tz) = fs::read_to_string(format!("{DIR}/keys.conf")).ok().and_then(|s| s.lines().find_map(|l| l.trim().strip_prefix("tz=").map(|v| v.trim().to_string()))).filter(|v| !v.is_empty()) {
        return Some((tz, "keys.conf"));
    }
    if let Ok(db) = fs::read("/var/local/system/TimeZoneCacheManager.db") {
        let text = String::from_utf8_lossy(&db);
        // the longest matching name wins, so America/Argentina/Buenos_Aires beats nothing shorter
        if let Some((_, rule)) = ZONES.iter().filter(|(name, _)| text.contains(name)).max_by_key(|(name, _)| name.len()) {
            return Some((rule.to_string(), "TimeZoneCacheManager.db"));
        }
    }
    if let Ok(v) = fs::read_to_string("/var/local/system/tzVar") {
        // KINDLE_TZ=GMT-06:00 means six hours behind UTC; POSIX writes that offset with the sign flipped
        if let Some(off) = v.lines().find_map(|l| l.trim().strip_prefix("KINDLE_TZ=GMT")) {
            let (sign, rest) = off.split_at(1);
            let mut parts = rest.split(':');
            if let (Some(h), m) = (parts.next().and_then(|h| h.parse::<u32>().ok()), parts.next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0)) {
                // the firmware records the standard offset only; assume the daylight rule of the
                // region that offset belongs to (override with tz= in keys.conf when that is wrong)
                let rule = match (sign, h, m) {
                    ("-", 4, 0) => Some("AST4ADT,M3.2.0,M11.1.0"), ("-", 5, 0) => Some("EST5EDT,M3.2.0,M11.1.0"),
                    ("-", 6, 0) => Some("CST6CDT,M3.2.0,M11.1.0"), ("-", 7, 0) => Some("MST7MDT,M3.2.0,M11.1.0"),
                    ("-", 8, 0) => Some("PST8PDT,M3.2.0,M11.1.0"), ("-", 9, 0) => Some("AKST9AKDT,M3.2.0,M11.1.0"),
                    ("+", 0, 0) | ("-", 0, 0) => Some("GMT0BST,M3.5.0/1,M10.5.0"), ("+", 1, 0) => Some("CET-1CEST,M3.5.0,M10.5.0/3"),
                    ("+", 2, 0) => Some("EET-2EEST,M3.5.0/3,M10.5.0/4"), _ => None,
                };
                if let Some(rule) = rule {
                    return Some((rule.to_string(), "tzVar offset, daylight rule assumed"));
                }
                let posix_sign = if sign == "-" { "" } else { "-" };
                let tz = if m == 0 { format!("<{sign}{h:02}>{posix_sign}{h}") } else { format!("<{sign}{h:02}{m:02}>{posix_sign}{h}:{m:02}") };
                return Some((tz, "tzVar offset"));
            }
        }
    }
    None
}

fn clock_hms() -> String {
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return String::from("--:--:--");
        }
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

pub fn log(msg: &str) {
    let line = format!("{} {msg}\n", clock_hms());
    print!("{line}");
    if let Ok(mut clients) = DEBUG_CLIENTS.lock() {
        clients.retain_mut(|c| c.write_all(line.as_bytes()).is_ok());
    }
    let mut f = fs::OpenOptions::new().create(true).append(true).open(format!("{DIR}/host.log"));
    if f.is_err() {
        let _ = fs::create_dir_all(WORK);
        f = fs::OpenOptions::new().create(true).append(true).open(format!("{WORK}/host.log"));
    }
    if let Ok(mut f) = f {
        let _ = f.write_all(line.as_bytes());
    }
}

fn lipc_set(src: &str, prop: &str, val: &str) {
    let _ = Command::new("lipc-set-prop").args([src, prop, val]).status();
}

const STORAGE_FILE: &str = "/var/local/eink-ui/storage.json";

/// UI state the app keeps between restarts (`__eink.storage_*`). Lives outside /mnt/us so USB
/// drive mode cannot take it away; written whole on every change, it stays tiny.
fn load_storage() -> BTreeMap<String, String> {
    fs::read_to_string(STORAGE_FILE).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_storage(map: &BTreeMap<String, String>) {
    let _ = fs::create_dir_all("/var/local/eink-ui");
    let tmp = format!("{STORAGE_FILE}.tmp");
    if let Ok(json) = serde_json::to_string(map) {
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, STORAGE_FILE);
        }
    }
}

fn battery_percent() -> u32 {
    fs::read_to_string("/sys/devices/system/wario_battery/wario_battery0/battery_capacity")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(100)
}

/// Minutes east of UTC according to the device's own timezone settings.
fn tz_offset_minutes() -> i64 {
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return 0;
        }
        (tm.tm_gmtoff / 60) as i64
    }
}

fn charging() -> bool {
    fs::read_to_string("/sys/devices/system/wario_charger/wario_charger0/charging").ok().and_then(|s| s.trim().parse::<i32>().ok()).map(|n| n != 0).unwrap_or(false)
}


/// While the storage was exported over USB the log went to tmpfs; copy it back once /mnt/us returns.
fn recover_hidden_log(name: &str) {
    for _ in 0..60 {
        if fs::metadata(DIR).is_ok() && fs::OpenOptions::new().append(true).open(format!("{DIR}/{name}")).is_ok() {
            if let Ok(hidden) = fs::read_to_string(format!("{WORK}/{name}")) {
                if !hidden.is_empty() {
                    if let Ok(mut f) = fs::OpenOptions::new().append(true).open(format!("{DIR}/{name}")) {
                        let _ = f.write_all(b"--- recovered from tmpfs ---\n");
                        let _ = f.write_all(hidden.as_bytes());
                    }
                    let _ = fs::write(format!("{WORK}/{name}"), "");
                }
            }
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Paint the damaged regions of the scene framebuffer to the e-ink panel: copy each rect into
/// /dev/fb0, then ask the EPDC for a region update (DU partial, or a flashing GC16 full).
/// Timings of the paints since the last event, for the slow-event log: (blit ms, epdc ms, rects, any full).
static PAINT_STATS: std::sync::Mutex<(u128, u128, usize, bool)> = std::sync::Mutex::new((0, 0, 0, false));

fn take_paint_stats() -> (u128, u128, usize, bool) {
    PAINT_STATS.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default()
}

fn paint(fb: &mut epdc::Epdc, scene: &Scene, damage: &[Damage]) {
    let w = eink_core::SCREEN_W as usize;
    let buf = scene.fb();
    let started = Instant::now();
    let mut blit_ms = 0u128;
    let mut any_full = false;
    for d in damage {
        let r = d.rect;
        let mut region = Vec::with_capacity((r.w * r.h) as usize);
        let invert = INVERT.load(std::sync::atomic::Ordering::Relaxed);
        for y in r.y..r.y + r.h {
            let row = y as usize * w;
            let line = &buf[row + r.x as usize..row + (r.x + r.w) as usize];
            if invert {
                region.extend(line.iter().map(|v| 255 - v));
            } else {
                region.extend_from_slice(line);
            }
        }
        let full = d.mode == Mode::Gc16;
        any_full |= full;
        let t = Instant::now();
        if let Err(e) = fb.blit_gray(&region, r.w as u32, r.h as u32, r.x as u32, r.y as u32) {
            log(&format!("blit failed: {e}"));
            continue;
        }
        blit_ms += t.elapsed().as_millis();
        if let Err(e) = fb.refresh(r.x as u32, r.y as u32, r.w as u32, r.h as u32, epdc::WAVEFORM_DU, full, false) {
            log(&format!("refresh failed: {e}"));
        }
    }
    if has_error() {
        draw_badge(fb);
    }
    if let Ok(mut g) = PAINT_STATS.lock() {
        g.0 += blit_ms;
        g.1 += started.elapsed().as_millis().saturating_sub(blit_ms);
        g.2 += damage.len();
        g.3 |= any_full;
    }
}

fn main() -> Result<()> {
    fs::create_dir_all(DIR)?;
    // volumd kills anything holding /mnt/us busy before exporting it over USB: never sit there
    let _ = std::env::set_current_dir("/");
    if fs::read_to_string(format!("{DIR}/keys.conf")).map(|s| s.lines().any(|l| l.trim() == "theme=dark")).unwrap_or(false) {
        INVERT.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    if let Some((tz, source)) = detect_tz() {
        std::env::set_var("TZ", &tz);
        log(&format!("timezone {tz} ({source})"));
    }
    log("eink-host starting");
    for prop in ["fsrkeypadEnable", "fsrkeypadPrevEnable", "fsrkeypadNextEnable"] {
        lipc_set("com.lab126.deviced", prop, "1");
    }
    lipc_set("com.lab126.powerd", "preventScreenSaver", "1");
    // the stock firewall drops inbound Wi-Fi connections: open the debug port
    let _ = Command::new("iptables").args(["-I", "INPUT", "-p", "tcp", "--dport", "2323", "-j", "ACCEPT"]).status();

    let (tx, rx) = mpsc::channel::<Event>();
    let (bundle, fetch_error) = load_bundle(&tx)?;
    let fb = Rc::new(RefCell::new(epdc::Epdc::open().context("open framebuffer")?));
    log(&fb.borrow().describe());
    if let Some(e) = fetch_error {
        set_error(&mut fb.borrow_mut(), &e);
    }
    let scene = Rc::new(RefCell::new(Scene::new()));
    // ghosting is cleared before every sleep, so a flash never interrupts a tap
    scene.borrow_mut().set_full_every(u32::MAX);
    input::start(tx.clone());
    {
        let tx = tx.clone();
        std::thread::spawn(move || watch_powerd(tx));
    }
    {
        let tx = tx.clone();
        std::thread::spawn(move || debug_server(tx));
    }

    let ui_storage: Rc<RefCell<BTreeMap<String, String>>> = Rc::new(RefCell::new(load_storage()));
    let pending_fetch: Rc<RefCell<BTreeMap<u32, Settle>>> = Rc::new(RefCell::new(BTreeMap::new()));
    repo::install_tools();
    repo::remove_old_checkout();
    let (repo_cmd, repo_state) = repo::start(tx.clone());
    if let Ok(mut g) = REPO_CMD.lock() {
        *g = Some(repo_cmd.clone());
    }
    if let Ok(mut g) = MAIN_TX.lock() {
        *g = Some(tx.clone());
    }
    if repo::configured() {
        let _ = repo_cmd.send(repo::SyncCmd::Now(None));
    }
    let rt = Runtime::new()?;
    rt.set_memory_limit(48 << 20);
    let ctx = JsContext::full(&rt)?;
    let listeners: Rc<RefCell<Vec<rquickjs::Persistent<Function<'static>>>>> = Rc::new(RefCell::new(Vec::new()));
    let timer_store: Rc<RefCell<BTreeMap<(Instant, u32), rquickjs::Persistent<Function<'static>>>>> = Rc::new(RefCell::new(BTreeMap::new()));

    ctx.with(|cx| -> Result<()> {
        let g = cx.globals();
        let eink = Object::new(cx.clone())?;
        {
            let sc = scene.clone();
            eink.set("create", Function::new(cx.clone(), move |kind: String| sc.borrow_mut().create(if kind == "text" { Kind::Text } else { Kind::Box }))?)?;
        }
        {
            let sc = scene.clone();
            eink.set("set_props", Function::new(cx.clone(), move |id: u32, json: String| {
                if let Err(e) = sc.borrow_mut().set_props(id, &json) {
                    log(&format!("set_props {id}: {e}"));
                }
            })?)?;
        }
        {
            let sc = scene.clone();
            eink.set("append", Function::new(cx.clone(), move |a: u32, b: u32| sc.borrow_mut().append(a, b))?)?;
        }
        {
            let sc = scene.clone();
            eink.set("insert_before", Function::new(cx.clone(), move |a: u32, b: u32, c: u32| sc.borrow_mut().insert_before(a, b, c))?)?;
        }
        {
            let sc = scene.clone();
            eink.set("remove", Function::new(cx.clone(), move |a: u32, b: u32| sc.borrow_mut().remove(a, b))?)?;
        }
        {
            let sc = scene.clone();
            eink.set("set_root", Function::new(cx.clone(), move |id: u32| sc.borrow_mut().set_root(id))?)?;
        }
        {
            let sc = scene.clone();
            eink.set("request_full", Function::new(cx.clone(), move || sc.borrow_mut().request_full())?)?;
        }
        {
            let sc = scene.clone();
            eink.set("hit", Function::new(cx.clone(), move |x: i32, y: i32| sc.borrow().hit(x, y))?)?;
        }
        {
            let sc = scene.clone();
            let fbc = fb.clone();
            eink.set("commit", Function::new(cx.clone(), move || {
                let damage = sc.borrow_mut().commit();
                paint(&mut fbc.borrow_mut(), &sc.borrow(), &damage);
                damage.len() as u32
            })?)?;
        }
        {
            let ls = listeners.clone();
            eink.set("on", Function::new(cx.clone(), move |cb: Function| {
                ls.borrow_mut().push(rquickjs::Persistent::save(&cb.ctx().clone(), cb));
            })?)?;
        }
        eink.set("log", Function::new(cx.clone(), |s: String| log(&format!("js: {s}")))?)?;
        {
            let fbc = fb.clone();
            eink.set("error", Function::new(cx.clone(), move |s: String| set_error(&mut fbc.borrow_mut(), &format!("js: {s}")))?)?;
        }
        eink.set("clear_error", Function::new(cx.clone(), || clear_error())?)?;
        eink.set("buzz", Function::new(cx.clone(), || {
            if let Err(e) = fs::write(HAPTIC, "1\n") {
                log(&format!("haptic: {e}"));
            }
        })?)?;
        // fetch never blocks the UI: the request runs on a thread and the promise is settled
        // from the main loop when Event::FetchDone arrives (see the prelude for the Response shape).
        {
            let pending = pending_fetch.clone();
            let tx = tx.clone();
            eink.set("_fetch_start", Function::new(cx.clone(), move |url: String, method: String, body: Option<String>, headers: String, resolve: Function, reject: Function| {
                let id = {
                    let mut p = pending.borrow_mut();
                    let id = p.keys().next_back().map_or(1, |k| k + 1);
                    let saved_resolve = rquickjs::Persistent::save(&resolve.ctx().clone(), resolve);
                    let saved_reject = rquickjs::Persistent::save(&reject.ctx().clone(), reject);
                    p.insert(id, (saved_resolve, saved_reject));
                    id
                };
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let result = http_request(&url, &method, body.as_deref(), &headers);
                    let _ = tx.send(Event::FetchDone(id, result));
                });
            })?)?;
        }
        eink.set("charging", Function::new(cx.clone(), || charging())?)?;
        eink.set("_battery", Function::new(cx.clone(), || format!(r#"{{"percent":{},"charging":{}}}"#, battery_percent(), charging()))?)?;
        eink.set("now", Function::new(cx.clone(), || now_secs() as f64 * 1000.0)?)?;
        eink.set("tz_offset", Function::new(cx.clone(), || tz_offset_minutes() as f64)?)?;
        {
            let st = ui_storage.clone();
            eink.set("_storage_get", Function::new(cx.clone(), move |k: String| serde_json::to_string(&st.borrow().get(&k)).unwrap_or_else(|_| "null".into()))?)?;
        }
        {
            let st = ui_storage.clone();
            eink.set("storage_set", Function::new(cx.clone(), move |k: String, v: String| {
                st.borrow_mut().insert(k, v);
                save_storage(&st.borrow());
            })?)?;
        }
        {
            let st = ui_storage.clone();
            eink.set("storage_remove", Function::new(cx.clone(), move |k: String| {
                if st.borrow_mut().remove(&k).is_some() {
                    save_storage(&st.borrow());
                }
            })?)?;
        }
        {
            let st = ui_storage.clone();
            eink.set("_storage_keys", Function::new(cx.clone(), move || serde_json::to_string(&st.borrow().keys().collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into()))?)?;
        }
        eink.set("_read_file", Function::new(cx.clone(), |p: String| serde_json::to_string(&repo::read_file(&p)).unwrap_or_else(|_| "null".into()))?)?;
        {
            let cmd = repo_cmd.clone();
            eink.set("write_file", Function::new(cx.clone(), move |p: String, text: String| {
                match repo::write_file(&p, &text) {
                    Ok(()) => { let _ = cmd.send(repo::SyncCmd::Commit(p)); }
                    Err(e) => log(&format!("write_file {p}: {e:#}")),
                }
            })?)?;
        }
        eink.set("_list_files", Function::new(cx.clone(), |prefix: String| serde_json::to_string(&repo::list_files(&prefix)).unwrap_or_else(|_| "[]".into()))?)?;
        {
            let st = repo_state.clone();
            eink.set("_sync_state", Function::new(cx.clone(), move || st.lock().map(|s| s.json()).unwrap_or_else(|_| "{}".into()))?)?;
        }
        {
            let cmd = repo_cmd.clone();
            eink.set("sync", Function::new(cx.clone(), move || { let _ = cmd.send(repo::SyncCmd::Now(None)); })?)?;
        }
        g.set("__eink", eink)?;
        g.set("__eink_exit", Function::new(cx.clone(), exit_to_kindle)?)?;

        // timers: setTimeout/clearTimeout backed by the host loop
        {
            let ts = timer_store.clone();
            g.set("setTimeout", Function::new(cx.clone(), move |cb: Function, ms: Opt<f64>| -> u32 {
                let mut t = ts.borrow_mut();
                let id = t.len() as u32 + 1 + (now_secs() as u32 % 1000) * 1000;
                let when = Instant::now() + Duration::from_millis(ms.0.unwrap_or(0.0).max(0.0) as u64);
                t.insert((when, id), rquickjs::Persistent::save(&cb.ctx().clone(), cb));
                id
            })?)?;
        }
        {
            let ts = timer_store.clone();
            g.set("clearTimeout", Function::new(cx.clone(), move |id: Opt<u32>| {
                if let Some(id) = id.0 {
                    ts.borrow_mut().retain(|k, _| k.1 != id);
                }
            })?)?;
        }
        g.set("console", {
            let c = Object::new(cx.clone())?;
            c.set("log", Function::new(cx.clone(), |s: Rest<Value>| { let parts: Vec<String> = s.0.iter().map(|v| format!("{v:?}")).collect(); log(&format!("console: {}", parts.join(" "))) })?)?;
            c.set("error", Function::new(cx.clone(), |s: Rest<Value>| { let parts: Vec<String> = s.0.iter().map(|v| format!("{v:?}")).collect(); log(&format!("console.error: {}", parts.join(" "))) })?)?;
            c.set("warn", Function::new(cx.clone(), |_s: Rest<Value>| {})?)?;
            c
        })?;

        let prelude = r#"
            globalThis.fetch = function (url, opts) {
              opts = opts || {};
              var body = opts.body === undefined || opts.body === null ? null : String(opts.body);
              var headers = opts.headers ? JSON.stringify(opts.headers) : "{}";
              return new Promise(function (resolve, reject) {
                __eink._fetch_start(String(url), String(opts.method || "GET"), body, headers, resolve, reject);
              }).then(function (raw) {
                var r = JSON.parse(raw);
                return {
                  ok: r.status >= 200 && r.status < 300, status: r.status, url: String(url),
                  headers: { get: function (n) { var v = r.headers[String(n).toLowerCase()]; return v === undefined ? null : v; } },
                  text: function () { return Promise.resolve(r.body); },
                  json: function () { return Promise.resolve(JSON.parse(r.body)); }
                };
              });
            };
            __eink.fetch = globalThis.fetch;
            __eink.battery = function () { return JSON.parse(__eink._battery()); };
            __eink.read_file = function (p) { return JSON.parse(__eink._read_file(String(p))); };
            __eink.list_files = function (prefix) { return JSON.parse(__eink._list_files(String(prefix || ""))); };
            __eink.sync_state = function () { return JSON.parse(__eink._sync_state()); };
            __eink.storage_get = function (k) { return JSON.parse(__eink._storage_get(String(k))); };
            __eink.storage_keys = function () { return JSON.parse(__eink._storage_keys()); };
            globalThis.window = globalThis; globalThis.self = globalThis;
        "#;
        cx.eval::<(), _>(prelude).map_err(|e| anyhow::anyhow!("prelude threw: {e}"))?;
        if let Err(e) = cx.eval::<(), _>(bundle.as_str()) {
            let detail = cx.catch();
            set_error(&mut fb.borrow_mut(), &format!("bundle threw: {e} {detail:?}"));
        }
        Ok(())
    })?;
    log("bundle loaded");

    // event loop: block until input, a timer, or a power event; JS never spins on its own
    let mut last_input = Instant::now();
    let mut last_sync = Instant::now();
    let sync_tx = tx.clone();
    let mut light_level: u32 = fs::read_to_string(FRONTLIGHT).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let mut last_light = Instant::now() - LIGHT_TICK;
    let mut last_tap = Instant::now() - Duration::from_secs(10);
    loop {
        let fb_for_panic = fb.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let next_timer = timer_store.borrow().keys().next().map(|k| k.0);
        let wait = next_timer.map(|t| t.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(30));
        let ev = rx.recv_timeout(wait.min(Duration::from_secs(30)));
        // fire due timers
        let due: Vec<_> = {
            let mut t = timer_store.borrow_mut();
            let now = Instant::now();
            let keys: Vec<_> = t.keys().filter(|k| k.0 <= now).cloned().collect();
            keys.into_iter().filter_map(|k| t.remove(&k)).collect()
        };
        if !due.is_empty() {
            ctx.with(|cx| {
                for cb in due {
                    if let Ok(f) = cb.restore(&cx) {
                        if let Err(e) = f.call::<_, ()>(()) {
                            let msg = format!("timer threw: {e}");
                            set_error(&mut fb.borrow_mut(), &msg);
                        }
                    }
                }
            });
            while rt.is_job_pending() {
                let _ = rt.execute_pending_job();
            }
        }
        let payload = match ev {
            Ok(Event::Tap(x, y)) => {
                last_input = Instant::now();
                repo::note_input();
                if last_tap.elapsed() < Duration::from_millis(250) {
                    return true;
                }
                last_tap = Instant::now();
                let id = scene.borrow().hit(x, y);
                log(&format!("tap ({x},{y}) -> node {id}"));
                Some(format!(r#"{{"type":"tap","id":{id},"x":{x},"y":{y}}}"#))
            }
            Ok(Event::Key(code)) => {
                last_input = Instant::now();
                repo::note_input();
                let key = match code { 104 => "PageUp", 109 => "PageDown", 116 => "Power", _ => "Unknown" };
                log(&format!("key {code} ({key})"));
                Some(format!(r#"{{"type":"key","key":"{key}","code":{code}}}"#))
            }
            Ok(Event::Eval(code, reply)) => {
                let out = ctx.with(|cx| match cx.eval::<Value, _>(code.as_str()) {
                    Ok(v) => match cx.json_stringify(v.clone()) {
                        Ok(Some(js)) => js.to_string().unwrap_or_default(),
                        _ => format!("{v:?}"),
                    },
                    Err(e) => format!("error: {e}"),
                });
                while rt.is_job_pending() {
                    let _ = rt.execute_pending_job();
                }
                let _ = reply.send(out);
                None
            }
            Ok(Event::FetchDone(id, result)) => {
                if let Some((resolve, reject)) = pending_fetch.borrow_mut().remove(&id) {
                    ctx.with(|cx| {
                        let outcome = match result {
                            Ok(json) => resolve.restore(&cx).and_then(|f| f.call::<_, ()>((json,))),
                            Err(msg) => reject.restore(&cx).and_then(|f| {
                                let err = rquickjs::Exception::from_message(cx.clone(), &msg)?;
                                f.call::<_, ()>((err,))
                            }),
                        };
                        if let Err(e) = outcome {
                            log(&format!("fetch settle failed: {e}"));
                        }
                    });
                    while rt.is_job_pending() {
                        let _ = rt.execute_pending_job();
                    }
                }
                None
            }
            Ok(Event::Synced(Ok(out))) => {
                if !out.changed.is_empty() {
                    log(&format!("store changed: {}", out.changed.join(", ")));
                }
                if out.changed.iter().any(|p| p.starts_with("bin/")) && repo::install_tools() {
                    let _ = repo_cmd.send(repo::SyncCmd::Now(None));
                }
                if out.app_changed || out.host_changed {
                    restart_self("/var/tmp/eink-host-run");
                }
                None
            }
            Ok(Event::Repaint) => {
                scene.borrow_mut().request_full();
                let d = scene.borrow_mut().commit();
                paint(&mut fb.borrow_mut(), &scene.borrow(), &d);
                None
            }
            Ok(Event::Files(changed)) => {
                // a bundle or host committed to the repository wins over the store's copy; the
                // bundle is copied first so a host restart already finds it
                let mut restart = false;
                if changed.iter().any(|p| p == "dist/app.js") {
                    if let Ok(b) = fs::read(format!("{}/dist/app.js", repo::REPO)) {
                        restart |= fs::write(format!("{DIR}/app.js"), &b).is_ok();
                    }
                }
                if changed.iter().any(|p| p == "bin/eink-host") {
                    if let Ok(b) = fs::read(format!("{}/bin/eink-host", repo::REPO)) {
                        let _ = fs::write(format!("{DIR}/eink-host"), &b);
                        restart |= install_host_binary(&b).is_ok();
                    }
                }
                if restart {
                    restart_self("/var/tmp/eink-host-run");
                }
                Some(serde_json::json!({"type": "files", "changed": changed}).to_string())
            }
            Ok(Event::SyncState(state)) => {
                Some(format!(r#"{{"type":"sync","sync":{}}}"#, state.json()))
            }
            Ok(Event::Synced(Err(e))) => {
                log(&format!("periodic sync failed: {e}"));
                None
            }
            Ok(Event::Reload) => {
                log("power button x5: reload");
                let _ = fs::write(HAPTIC, "1\n");
                restart_self("/var/tmp/eink-host-run");
            }
            Ok(Event::Power(line)) => {
                log(&format!("powerd: {line}"));
                if line.starts_with("charging") || line.starts_with("notCharging") {
                    // USB drive mode blanks the panel: unblank and repaint the whole scene from memory
                    std::thread::sleep(Duration::from_secs(2));
                    fb.borrow_mut().unblank();
                    if line.starts_with("notCharging") {
                        std::thread::spawn(|| recover_hidden_log("host.log"));
                    }
                    scene.borrow_mut().request_full();
                    let d = scene.borrow_mut().commit();
                    paint(&mut fb.borrow_mut(), &scene.borrow(), &d);
                    log("repainted after cable change");
                }
                None
            }
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        };
        if let Some(p) = payload {
            let _ = take_paint_stats();
            let started = Instant::now();
            ctx.with(|cx| {
                let ls = listeners.borrow();
                for cb in ls.iter() {
                    if let Ok(f) = cb.clone().restore(&cx) {
                        let v: Value = cx.json_parse(p.as_str()).unwrap();
                        if let Err(e) = f.call::<_, ()>((v,)) {
                            let msg = format!("listener threw: {e}");
                            set_error(&mut fb.borrow_mut(), &msg);
                        }
                    }
                }
            });
            while rt.is_job_pending() {
                let _ = rt.execute_pending_job();
            }
            let total = started.elapsed().as_millis();
            if total as u64 >= SLOW_MS.load(std::sync::atomic::Ordering::Relaxed) {
                let (blit, epdc, rects, full) = take_paint_stats();
                let kind: String = p.chars().skip(9).take_while(|c| *c != '"').collect();
                let busy = repo_state.lock().map(|s| s.state == "syncing").unwrap_or(false);
                log(&format!(
                    "slow {kind}: {total} ms (js {} ms, blit {blit} ms, epdc {epdc} ms, {rects} rects{}{})",
                    total.saturating_sub(blit + epdc), if full { ", full flash" } else { "" }, if busy { ", git busy" } else { "" }
                ));
            }
        }
        if last_light.elapsed() >= LIGHT_TICK {
            last_light = Instant::now();
            if let Some(level) = auto_light_step(&mut light_level) {
                log(&format!("frontlight {level} for {} lux", ambient_lux().unwrap_or(0)));
            }
        }
        if last_sync.elapsed() >= Duration::from_secs(300) {
            last_sync = Instant::now();
            let tx = sync_tx.clone();
            std::thread::spawn(move || {
                let _ = tx.send(Event::Synced(sync_files().map_err(|e| format!("{e:#}"))));
            });
            let _ = repo_cmd.send(repo::SyncCmd::Now(None));
        }
        if !charging() && last_input.elapsed() >= IDLE_AFTER {
            deliver(&ctx, &rt, &listeners, &fb, r#"{"type":"power","state":"sleep"}"#);
            // idle is the time to clear ghosting: nobody is waiting on this flash
            if scene.borrow().partials_since_full() > 0 {
                scene.borrow_mut().request_full();
                let d = scene.borrow_mut().commit();
                paint(&mut fb.borrow_mut(), &scene.borrow(), &d);
            }
            let deferred = sleep_cycle(&rx, &repo_cmd);
            deliver(&ctx, &rt, &listeners, &fb, r#"{"type":"power","state":"wake"}"#);
            for ev in deferred {
                let payload = match ev {
                    Event::Files(changed) => serde_json::json!({"type": "files", "changed": changed}).to_string(),
                    Event::SyncState(state) => format!(r#"{{"type":"sync","sync":{}}}"#, state.json()),
                    _ => continue,
                };
                deliver(&ctx, &rt, &listeners, &fb, &payload);
            }
            last_input = Instant::now();
        }
        true
        }));
        match result {
            Ok(true) => {}
            Ok(false) => break,
            Err(p) => {
                let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
                if let Ok(mut fb) = fb_for_panic.try_borrow_mut() {
                    set_error(&mut fb, &format!("panic: {msg}"));
                } else {
                    log(&format!("panic: {msg}"));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    Ok(())
}

fn exit_to_kindle() {
    lipc_set("com.lab126.powerd", "preventScreenSaver", "0");
    log("exiting; restarting Kindle UI");
    let _ = Command::new("start").arg("lab126_gui").status();
    std::process::exit(0)
}

/// Remote debugger: `nc <kindle-ip> 2323` streams the log; each line you type is evaluated as
/// JavaScript in the app's context and the result is printed back. LAN only, no auth.
fn debug_server(tx: mpsc::Sender<Event>) {
    use std::io::{BufRead, BufReader};
    let Ok(listener) = std::net::TcpListener::bind("0.0.0.0:2323") else {
        log("debug server: bind failed");
        return;
    };
    log("debug server listening on :2323");
    for stream in listener.incoming().flatten() {
        let _ = stream.set_nodelay(true);
        let mut writer = match stream.try_clone() {
            Ok(w) => w,
            Err(_) => continue,
        };
        let _ = writer.set_write_timeout(Some(Duration::from_millis(500)));
        let _ = writer.write_all(b"eink-host debug: type JS, get results; log lines stream here\n");
        if let Ok(mut c) = DEBUG_CLIENTS.lock() {
            if let Ok(w) = writer.try_clone() {
                c.push(w);
            }
        }
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let code = line.trim().to_string();
                if code.is_empty() {
                    continue;
                }
                if let Some(cmd) = code.strip_prefix(':') {
                    let reply = debug_command(cmd.trim());
                    if writer.write_all(format!("=> {reply}\n").as_bytes()).is_err() {
                        break;
                    }
                    continue;
                }
                let (rtx, rrx) = mpsc::channel();
                if tx.send(Event::Eval(code, rtx)).is_err() {
                    break;
                }
                let reply = rrx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| "(timeout)".into());
                if writer.write_all(format!("=> {reply}\n").as_bytes()).is_err() {
                    break;
                }
            }
        });
    }
}

const DEFAULT_UPDATE_URL: &str = "https://kindle-todo-one.vercel.app/";

/// keys.conf: `update_url=https://host/dir/` — a location serving app.js (and eink-host).
fn update_url() -> String {
    fs::read_to_string(format!("{DIR}/keys.conf"))
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.trim().strip_prefix("update_url=").map(|v| v.trim().to_string())))
        .unwrap_or_else(|| String::from(DEFAULT_UPDATE_URL))
}

fn set_update_url(url: &str) -> std::io::Result<()> {
    let url = if url.ends_with('/') { url.to_string() } else { format!("{url}/") };
    fs::write(format!("{DIR}/keys.conf"), format!("update_url={url}\n"))
}

/// Relative, forward-slash paths only: a manifest entry maps straight onto DIR/<path>.
fn valid_rel_path(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.contains('\0')
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
        && !matches!(p, ".sync.json" | ".manifest.etag" | "keys.conf")
}

/// GET with an ETag; `Ok(None)` means 304, nothing changed.
fn fetch_if_changed(url: &str, etag: Option<&str>) -> Result<Option<(Vec<u8>, Option<String>)>> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
    let mut req = agent.get(url);
    if let Some(e) = etag {
        req = req.set("If-None-Match", e);
    }
    match req.call() {
        Ok(resp) => {
            let tag = resp.header("ETag").map(str::to_string);
            let mut buf = Vec::new();
            resp.into_reader().read_to_end(&mut buf)?;
            Ok(Some((buf, tag)))
        }
        Err(ureq::Error::Status(304, _)) => Ok(None),
        Err(e) => Err(anyhow::Error::from(e).context(format!("GET {url}"))),
    }
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(data))
}

fn install_host_binary(data: &[u8]) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let tmp = "/var/tmp/eink-host-run.new";
    fs::write(tmp, data)?;
    fs::set_permissions(tmp, fs::Permissions::from_mode(0o755))?;
    fs::rename(tmp, "/var/tmp/eink-host-run")?;
    Ok(())
}

/// The device holds nothing but the URL. `update_url` serves a manifest.json (see eink-mcp)
/// listing files with their sha256; this pulls whatever changed into DIR, removes what left the
/// manifest, and remembers the manifest ETag so an unchanged store costs one small request.
/// A store without a manifest (a plain directory with app.js) still works: app.js alone is fetched.
fn sync_files() -> Result<SyncOutcome> {
    let base = update_url();
    let index_path = format!("{DIR}/.sync.json");
    let etag_path = format!("{DIR}/.manifest.etag");
    let mut index: BTreeMap<String, String> =
        fs::read_to_string(&index_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let etag = fs::read_to_string(&etag_path).ok();
    let mut out = SyncOutcome::default();
    let mut stale = false;
    let manifest_url = format!("{base}manifest.json");
    let fetched = match fetch_if_changed(&manifest_url, etag.as_deref()) {
        Ok(f) => f,
        Err(e) if format!("{e:#}").contains("status code 404") => {
            // legacy store: only app.js, no manifest
            let data = download(&format!("{base}app.js"))?;
            let text = String::from_utf8(data).context("app.js is not UTF-8")?;
            let changed = fs::read_to_string(format!("{DIR}/app.js")).ok().as_deref() != Some(text.as_str());
            fs::write(format!("{DIR}/app.js"), &text)?;
            out.app_changed = changed;
            if changed {
                out.changed.push("app.js".into());
            }
            return Ok(out);
        }
        Err(e) => return Err(e),
    };
    let Some((bytes, tag)) = fetched else { return Ok(out) };
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).context("manifest.json is not JSON")?;
    let files = manifest.get("files").and_then(|f| f.as_object()).context("manifest.json has no files object")?;
    for (path, entry) in files {
        if !valid_rel_path(path) {
            log(&format!("sync: ignoring bad path {path:?}"));
            continue;
        }
        let sha = entry.get("sha256").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let local = format!("{DIR}/{path}");
        if index.get(path) == Some(&sha) && std::path::Path::new(&local).exists() {
            continue;
        }
        let url = entry.get("url").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| format!("{base}{path}"));
        // the CDN can still serve the previous copy for a minute after a put: skip it, next sync retries
        let data = download(&format!("{url}?t={}", now_secs()))?;
        if !sha.is_empty() && sha256_hex(&data) != sha {
            log(&format!("sync: {path} does not match its manifest hash yet, retrying later"));
            stale = true;
            continue;
        }
        if let Some(dir) = std::path::Path::new(&local).parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = format!("{local}.part");
        fs::write(&tmp, &data)?;
        fs::rename(&tmp, &local)?;
        if path == "eink-host" {
            install_host_binary(&data)?;
            out.host_changed = true;
        }
        if path == "app.js" {
            out.app_changed = true;
        }
        index.insert(path.clone(), sha);
        out.changed.push(path.clone());
        log(&format!("synced {path} ({} bytes)", data.len()));
    }
    for path in index.keys().cloned().collect::<Vec<_>>() {
        if !files.contains_key(&path) {
            let _ = fs::remove_file(format!("{DIR}/{path}"));
            index.remove(&path);
            out.removed.push(path);
        }
    }
    fs::write(&index_path, serde_json::to_string(&index)?)?;
    if let Some(t) = tag.filter(|_| !stale) {
        let _ = fs::write(&etag_path, t);
    }
    if !out.removed.is_empty() {
        log(&format!("sync: removed {}", out.removed.join(", ")));
    }
    Ok(out)
}

/// Start-up. With a local app.js the UI comes up at once and the store syncs in the background
/// (a changed bundle or host restarts). Only a first start with nothing local waits for the
/// network, a few tries, since Wi-Fi may still be coming up.
fn load_bundle(tx: &mpsc::Sender<Event>) -> Result<(String, Option<String>)> {
    let cached = format!("{DIR}/app.js");
    if let Ok(text) = fs::read_to_string(&cached) {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Event::Synced(sync_files().map_err(|e| format!("{e:#}"))));
        });
        return Ok((text, None));
    }
    let mut last_err = String::new();
    for attempt in 1..=4 {
        match sync_files() {
            Ok(out) => {
                log(&format!("store in sync ({} changed)", out.changed.len()));
                break;
            }
            Err(e) => last_err = format!("{e:#}"),
        }
        log(&format!("sync {attempt}/4 failed: {last_err}"));
        std::thread::sleep(Duration::from_secs(3));
    }
    match fs::read_to_string(&cached) {
        Ok(text) => Ok((text, None)),
        Err(_) => anyhow::bail!("no bundle: {last_err} and no local app.js"),
    }
}

type Settle = (rquickjs::Persistent<Function<'static>>, rquickjs::Persistent<Function<'static>>);

/// One HTTP round trip for the JS fetch. HTTP error statuses are results, not errors,
/// like the web's fetch; only transport failures reject.
fn http_request(url: &str, method: &str, body: Option<&str>, headers_json: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build();
    let mut req = agent.request(method, url);
    if let Ok(serde_json::Value::Object(h)) = serde_json::from_str::<serde_json::Value>(headers_json) {
        for (k, v) in h {
            if let Some(v) = v.as_str() {
                req = req.set(&k, v);
            }
        }
    }
    if body.is_some() && !headers_json.to_ascii_lowercase().contains("content-type") {
        req = req.set("Content-Type", "application/json");
    }
    let resp = match body {
        Some(b) => req.send_string(b),
        None => req.call(),
    };
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("{e}")),
    };
    let status = resp.status();
    let mut headers = serde_json::Map::new();
    for name in resp.headers_names() {
        if let Some(v) = resp.header(&name) {
            headers.insert(name.to_ascii_lowercase(), serde_json::Value::String(v.to_string()));
        }
    }
    let body = resp.into_string().map_err(|e| format!("read body: {e}"))?;
    Ok(serde_json::json!({"status": status, "headers": headers, "body": body}).to_string())
}

fn download(url: &str) -> Result<Vec<u8>> {
    let resp = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build().get(url).call().with_context(|| format!("GET {url}"))?;
    let mut buf = Vec::new();
    resp.into_reader().read_to_end(&mut buf)?;
    Ok(buf)
}

/// Hands one host event to every JS listener and runs the jobs it queued (a React commit paints).
fn deliver(ctx: &JsContext, rt: &Runtime, listeners: &Rc<RefCell<Vec<rquickjs::Persistent<Function<'static>>>>>, fb: &Rc<RefCell<epdc::Epdc>>, payload: &str) {
    ctx.with(|cx| {
        let ls = listeners.borrow();
        for cb in ls.iter() {
            if let Ok(f) = cb.clone().restore(&cx) {
                if let Ok(v) = cx.json_parse(payload) {
                    if let Err(e) = f.call::<_, ()>((v,)) {
                        set_error(&mut fb.borrow_mut(), &format!("listener threw: {e}"));
                    }
                }
            }
        }
    });
    while rt.is_job_pending() {
        let _ = rt.execute_pending_job();
    }
}

/// Re-exec the running binary so the new bundle/binary takes over with a clean state.
fn restart_self(path: &str) -> ! {
    use std::os::unix::process::CommandExt;
    log(&format!("restarting via {path}"));
    let err = Command::new(path).exec();
    log(&format!("exec failed: {err}"));
    std::process::exit(1)
}

/// Over-the-air maintenance, no USB needed:
///   :reload         restart (every start syncs the store at update_url)
///   :sync           pull the store now; restarts if app.js or eink-host changed
///   :update         fetch eink-host from update_url, install, restart
///   :restart        restart with the current files
///   :exit           hand the screen back to the Kindle UI
///   :battery        battery + charger state
fn debug_command(cmd: &str) -> String {
    match cmd {
        "reload" => {
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                restart_self("/var/tmp/eink-host-run");
            });
            "restarting; the start refetches app.js".into()
        }
        "update" => {
            let url = format!("{}eink-host", update_url());
            match download(&url) {
                Ok(b) => {
                    let tmp = "/var/tmp/eink-host-run.new";
                    if let Err(e) = fs::write(tmp, &b) {
                        return format!("could not write {tmp}: {e}");
                    }
                    let _ = fs::set_permissions(tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755));
                    let _ = fs::write(format!("{DIR}/eink-host"), &b); // persist when /mnt/us is available
                    let _ = fs::rename(tmp, "/var/tmp/eink-host-run");
                    log(&format!("updated eink-host ({} bytes) from {url}", b.len()));
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_millis(300));
                        restart_self("/var/tmp/eink-host-run");
                    });
                    format!("ok, {} bytes; restarting", b.len())
                }
                Err(e) => format!("update failed: {e:#}"),
            }
        }
        "restart" => {
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                restart_self("/var/tmp/eink-host-run");
            });
            "restarting".into()
        }
        "exit" => {
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                exit_to_kindle();
            });
            "exiting to Kindle UI".into()
        }
        c if c.starts_with("url ") => match set_update_url(c[4..].trim()) {
            Ok(()) => format!("update_url={}", update_url()),
            Err(e) => format!("could not write keys.conf: {e}"),
        },
        "url" => format!("update_url={}", update_url()),
        c if c.starts_with("repo ") => match repo::set_conf("repo_url", c[5..].trim()) {
            Ok(()) => {
                if let Ok(g) = REPO_CMD.lock() {
                    if let Some(cmd) = g.as_ref() {
                        let _ = cmd.send(repo::SyncCmd::Now(None));
                    }
                }
                format!("repo_url={}", repo::repo_url().unwrap_or_default())
            }
            Err(e) => format!("could not write keys.conf: {e}"),
        },
        "repo" => format!("repo_url={} backend={} tools_ready={} checkout={} free={} MiB (tools partition {} MiB)", repo::repo_url().unwrap_or_else(|| "(none)".into()), match repo::config() { Ok(Some(repo::Remote::Github(_))) => "github-https", Ok(Some(repo::Remote::Git(_))) => "git-ssh", Ok(None) => "none", Err(_) => "misconfigured" }, repo::tools_ready(), repo::REPO, repo::free_mib(), repo::free_mib_at(repo::BASE)),
        c if c.starts_with("tap ") => {
            let n: Vec<i32> = c[4..].split_whitespace().filter_map(|v| v.parse().ok()).collect();
            match (n.first(), n.get(1), MAIN_TX.lock().ok().and_then(|g| g.clone())) {
                (Some(&x), Some(&y), Some(tx)) => { let _ = tx.send(Event::Tap(x, y)); format!("tap {x} {y}") }
                _ => "usage: :tap <x> <y>".into(),
            }
        }
        c if c.starts_with("key ") => {
            let code = match c[4..].trim() { "PageUp" | "left" | "prev" => 104, "PageDown" | "right" | "next" => 109, "Power" => 116, _ => 0 };
            match (code, MAIN_TX.lock().ok().and_then(|g| g.clone())) {
                (0, _) => "usage: :key PageUp|PageDown|Power".into(),
                (code, Some(tx)) => { let _ = tx.send(Event::Key(code)); format!("key {code}") }
                _ => "no main loop".into(),
            }
        }
        c if c.starts_with("slow ") => match c[5..].trim().parse::<u64>() {
            Ok(ms) => { SLOW_MS.store(ms, std::sync::atomic::Ordering::Relaxed); format!("logging events slower than {ms} ms") }
            Err(_) => "usage: :slow <ms>".into(),
        },
        c if c.starts_with("log") => {
            // :log [n]  the last n lines of the host log, for sessions nobody was watching
            let n: usize = c[3..].trim().parse().unwrap_or(40);
            let text = fs::read_to_string(format!("{DIR}/host.log")).or_else(|_| fs::read_to_string(format!("{WORK}/host.log"))).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join(" | ")
        }
        c if c.starts_with("conf ") => match c[5..].trim().split_once('=') {
            // :conf key=value   writes keys.conf (tz=, update_url=, repo_url=, repo_branch=); restart to apply
            Some((k, v)) if !k.trim().is_empty() => match repo::set_conf(k.trim(), v.trim()) {
                Ok(()) => format!("{}={} (restart to apply)", k.trim(), v.trim()),
                Err(e) => format!("could not write keys.conf: {e}"),
            },
            _ => "usage: :conf key=value".into(),
        },
        c if c.starts_with("ls ") => {
            // :ls <dir>   read-only listing, for finding where the stock firmware keeps things
            match fs::read_dir(c[3..].trim()) {
                Ok(rd) => {
                    let mut names: Vec<String> = rd.flatten().map(|e| {
                        let t = e.file_type().ok();
                        let mark = if t.is_some_and(|t| t.is_dir()) { "/" } else if t.is_some_and(|t| t.is_symlink()) { "@" } else { "" };
                        format!("{}{mark}", e.file_name().to_string_lossy())
                    }).collect();
                    names.sort();
                    names.join(" ")
                }
                Err(e) => format!("ls: {e}"),
            }
        }
        c if c.starts_with("cat ") => {
            // :cat <file>   the first 2000 bytes of a text file, lossy
            match fs::read(c[4..].trim()) {
                Ok(b) => String::from_utf8_lossy(&b[..b.len().min(2000)]).replace('\n', " | "),
                Err(e) => format!("cat: {e}"),
            }
        }
        c if c.starts_with("strings ") => {
            // :strings <file>   printable runs of 6+ bytes, first 3000 chars: what a binary file says
            match fs::read(c[8..].trim()) {
                Ok(b) => {
                    let mut out = String::new();
                    let mut run = String::new();
                    for &byte in &b {
                        if (0x20..0x7f).contains(&byte) { run.push(byte as char); } else { if run.len() >= 6 { out.push_str(&run); out.push(' '); } run.clear(); }
                        if out.len() > 3000 { break; }
                    }
                    out
                }
                Err(e) => format!("strings: {e}"),
            }
        }
        c if c.starts_with("theme") => {
            // :theme dark|light   inverts the panel live and remembers it in keys.conf
            match c[5..].trim() {
                "dark" | "light" => {
                    let dark = c[5..].trim() == "dark";
                    INVERT.store(dark, std::sync::atomic::Ordering::Relaxed);
                    let _ = repo::set_conf("theme", if dark { "dark" } else { "" });
                    if let Some(tx) = MAIN_TX.lock().ok().and_then(|g| g.clone()) {
                        let _ = tx.send(Event::Repaint);
                    }
                    format!("theme {}", if dark { "dark" } else { "light" })
                }
                _ => format!("theme {}; usage: :theme dark|light", if INVERT.load(std::sync::atomic::Ordering::Relaxed) { "dark" } else { "light" }),
            }
        }
        c if c.starts_with("light") => {
            // :light auto|off|<0-4095>   frontlight policy, remembered in keys.conf
            let v = c[5..].trim();
            match v {
                "" => format!("frontlight={} lux={} level={}", frontlight_setting(), ambient_lux().map(|l| l.to_string()).unwrap_or("?".into()), fs::read_to_string(FRONTLIGHT).unwrap_or_default().trim()),
                "auto" => { let _ = repo::set_conf("frontlight", "auto"); "frontlight=auto (next tick)".into() }
                "off" => { let _ = repo::set_conf("frontlight", "off"); set_frontlight(0); "frontlight=off".into() }
                n => match n.parse::<u32>() {
                    Ok(level) if level <= FRONTLIGHT_MAX => { let _ = repo::set_conf("frontlight", n); set_frontlight(level); format!("frontlight={level}") }
                    _ => "usage: :light auto|off|<0-4095>".into(),
                },
            }
        }
        "sshkey" => match repo::public_key() {
            Ok(k) => k,
            Err(e) => format!("no key: {e:#}"),
        },
        "sync" => match {
            if let Ok(g) = REPO_CMD.lock() {
                if let Some(cmd) = g.as_ref() {
                    let _ = cmd.send(repo::SyncCmd::Now(None));
                }
            }
            sync_files()
        } {
            Ok(out) => {
                if out.app_changed || out.host_changed {
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_millis(300));
                        restart_self("/var/tmp/eink-host-run");
                    });
                }
                format!("changed: [{}] removed: [{}]{}", out.changed.join(", "), out.removed.join(", "),
                    if out.app_changed || out.host_changed { "; restarting" } else { "" })
            }
            Err(e) => format!("sync failed: {e:#}"),
        },
        "battery" => format!("charging={} {}", charging(), fs::read_to_string("/sys/devices/system/wario_battery/wario_battery0/battery_capacity").map(|s| s.trim().to_string() + "%").unwrap_or_default()),
        _ => "commands: :reload :update :restart :exit :battery :url [https://host/dir/] :sync :repo [git@host:owner/repo.git] :sshkey :tap <x> <y> :key PageUp|PageDown :slow <ms> :log [n] :conf key=value :ls <dir> :cat <file> :theme dark|light :light auto|off|<n>".into(),
    }
}

/// Streams powerd lifecycle events (charger, screensaver) into the event loop.
fn watch_powerd(tx: mpsc::Sender<Event>) {
    use std::io::{BufRead, BufReader};
    loop {
        let child = Command::new("lipc-wait-event")
            .args(["-m", "-s", "0", "com.lab126.powerd", "goingToScreenSaver,outOfScreenSaver,charging,notCharging,wakeupFromSuspend,readyToSuspend"])
            .stdout(std::process::Stdio::piped())
            .spawn();
        let Ok(mut child) = child else {
            log("lipc-wait-event unavailable");
            return;
        };
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if !line.is_empty() && tx.send(Event::Power(line)).is_err() {
                    return;
                }
            }
        }
        let _ = child.wait();
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Same policy as the todo app: radio off, frontlight off, RTC wake every 30 min, resume on power key.
/// Sleeps until a button or the USB cable wakes the device, syncing on each timed wake. A pull
/// that lands during a timed wake is not thrown away: a new bundle or host restarts the host at
/// once, and other file changes are returned so the app hears about them once it is awake.
fn sleep_cycle(rx: &mpsc::Receiver<Event>, repo_cmd: &mpsc::Sender<repo::SyncCmd>) -> Vec<Event> {
    let mut deferred = Vec::new();
    log("idle on battery, sleeping");
    let light = fs::read_to_string(FRONTLIGHT).ok().map(|v| v.trim().to_string()).filter(|v| v != "0");
    let _ = fs::write(FRONTLIGHT, "0\n");
    loop {
        lipc_set("com.lab126.wifid", "enable", "0");
        let alarm = "/sys/class/rtc/rtc1/wakealarm";
        let _ = fs::write(alarm, "0\n");
        if fs::write(alarm, "+1800\n").is_err() {
            let _ = Command::new("rtcwake").args(["-d", "/dev/rtc1", "-m", "no", "-s", "1800"]).status();
        }
        let target = now_secs() + 1800;
        std::thread::sleep(Duration::from_secs(2));
        if fs::write("/sys/power/state", "mem\n").is_err() {
            log("suspend failed; staying awake");
            break;
        }
        let early = now_secs() + 5 < target;
        log(&format!("woke up ({})", if early { "button/USB" } else { "RTC" }));
        lipc_set("com.lab126.wifid", "enable", "1");
        if early || charging() {
            break;
        }
        // RTC wake: Wi-Fi needs a moment, then pull the store and sleep again
        std::thread::sleep(Duration::from_secs(8));
        match sync_files() {
            Ok(out) if out.app_changed || out.host_changed => restart_self("/var/tmp/eink-host-run"),
            Ok(out) if !out.changed.is_empty() => log(&format!("store changed: {}", out.changed.join(", "))),
            Ok(_) => {}
            Err(e) => log(&format!("wake sync failed: {e:#}")),
        }
        if repo::configured() {
            let (ack_tx, ack_rx) = mpsc::channel();
            let _ = repo_cmd.send(repo::SyncCmd::Now(Some(ack_tx)));
            let _ = ack_rx.recv_timeout(Duration::from_secs(40));
        }
        let window = Instant::now() + Duration::from_secs(12);
        let mut wake = false;
        while let Ok(ev) = rx.recv_timeout(window.saturating_duration_since(Instant::now())) {
            match ev {
                Event::Files(changed) => {
                    if changed.iter().any(|p| p == "dist/app.js" || p == "bin/eink-host") {
                        log("repo changed the bundle or host while asleep: installing");
                        if let Ok(b) = fs::read(format!("{}/dist/app.js", repo::REPO)) {
                            let _ = fs::write(format!("{DIR}/app.js"), &b);
                        }
                        if let Ok(b) = fs::read(format!("{}/bin/eink-host", repo::REPO)) {
                            let _ = fs::write(format!("{DIR}/eink-host"), &b);
                            let _ = install_host_binary(&b);
                        }
                        restart_self("/var/tmp/eink-host-run");
                    }
                    deferred.push(Event::Files(changed));
                }
                Event::SyncState(s) => deferred.push(Event::SyncState(s)),
                Event::Synced(Ok(out)) if out.app_changed || out.host_changed => restart_self("/var/tmp/eink-host-run"),
                Event::Power(_) | Event::Eval(..) | Event::Reload | Event::Synced(_) | Event::FetchDone(..) => {}
                _ => { wake = true; break; }
            }
        }
        if wake {
            break;
        }
    }
    if let Some(v) = light {
        let _ = fs::write(FRONTLIGHT, format!("{v}\n"));
    }
    deferred
}
