//! eink-host: runs the React bundle in QuickJS against eink-core, paints damage rects through
//! FBInk region updates, feeds touch/PagePress input, and applies the todo app's power policy.
//! Static state = blocked on the input channel; JS only runs on events and timers.
mod epdc;
mod input;

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

const DIR: &str = "/mnt/us/todo-app";
const WORK: &str = "/var/tmp/todo-app";
const IDLE_AFTER: Duration = Duration::from_secs(180);
const FRONTLIGHT: &str = "/sys/class/backlight/max77696-bl/brightness";
const HAPTIC: &str = "/sys/devices/system/drv26xx_haptics/drv26xx_haptics0/play_waveform";

pub enum Event {
    Tap(i32, i32),
    Key(u16),
    Power(String),
    Eval(String, mpsc::Sender<String>),
    /// Power button released after being held this long.
    PowerHeld(Duration),
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

pub fn log(msg: &str) {
    let ts = Command::new("date").arg("+%H:%M:%S").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let line = format!("{ts} {msg}\n");
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
fn paint(fb: &mut epdc::Epdc, scene: &Scene, damage: &[Damage]) {
    let w = eink_core::SCREEN_W as usize;
    let buf = scene.fb();
    for d in damage {
        let r = d.rect;
        let mut region = Vec::with_capacity((r.w * r.h) as usize);
        for y in r.y..r.y + r.h {
            let row = y as usize * w;
            region.extend_from_slice(&buf[row + r.x as usize..row + (r.x + r.w) as usize]);
        }
        let full = d.mode == Mode::Gc16;
        if let Err(e) = fb.blit_gray(&region, r.w as u32, r.h as u32, r.x as u32, r.y as u32) {
            log(&format!("blit failed: {e}"));
            continue;
        }
        if let Err(e) = fb.refresh(r.x as u32, r.y as u32, r.w as u32, r.h as u32, epdc::WAVEFORM_DU, full, full) {
            log(&format!("refresh failed: {e}"));
        }
    }
    if has_error() {
        draw_badge(fb);
    }
}

fn main() -> Result<()> {
    fs::create_dir_all(DIR)?;
    // volumd kills anything holding /mnt/us busy before exporting it over USB: never sit there
    let _ = std::env::set_current_dir("/");
    log("eink-host starting");
    for prop in ["fsrkeypadEnable", "fsrkeypadPrevEnable", "fsrkeypadNextEnable"] {
        lipc_set("com.lab126.deviced", prop, "1");
    }
    lipc_set("com.lab126.powerd", "preventScreenSaver", "1");

    let bundle = fs::read_to_string(format!("{DIR}/app.js")).context("read app.js")?;
    let fb = Rc::new(RefCell::new(epdc::Epdc::open().context("open framebuffer")?));
    log(&fb.borrow().describe());
    let scene = Rc::new(RefCell::new(Scene::new()));
    let (tx, rx) = mpsc::channel::<Event>();
    input::start(tx.clone());
    {
        let tx = tx.clone();
        std::thread::spawn(move || watch_powerd(tx));
    }
    {
        let tx = tx.clone();
        std::thread::spawn(move || debug_server(tx));
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
        // blocking fetch: returns a JSON string {"status","body"}; a JS prelude wraps it in an object.
        // The app runs on events only, so blocking here is fine.
        eink.set("_fetch", Function::new(cx.clone(), |url: String, method: Option<String>, body: Option<String>| -> String {
            let method = method.unwrap_or_else(|| String::from("GET"));
            let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build();
            let req = agent.request(&method, &url).set("content-type", "application/json");
            let resp = match body { Some(b) => req.send_string(&b), None => req.call() };
            let (status, text) = match resp {
                Ok(r) => (r.status(), r.into_string().unwrap_or_default()),
                Err(ureq::Error::Status(c, r)) => (c, r.into_string().unwrap_or_default()),
                Err(e) => (0, e.to_string()),
            };
            serde_json::json!({ "status": status, "body": text }).to_string()
        })?)?;
        eink.set("charging", Function::new(cx.clone(), || charging())?)?;
        eink.set("now", Function::new(cx.clone(), || now_secs() as f64)?)?;
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
            __eink.fetch = function (url, opts) {
              opts = opts || {};
              var raw = opts.body === undefined || opts.body === null ? __eink._fetch(url, opts.method || "GET", null) : __eink._fetch(url, opts.method || "GET", String(opts.body));
              var r = JSON.parse(raw);
              return { ok: r.status >= 200 && r.status < 300, status: r.status, text: function () { return r.body; }, json: function () { return JSON.parse(r.body); } };
            };
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
                if last_tap.elapsed() < Duration::from_millis(500) {
                    return true;
                }
                last_tap = Instant::now();
                let id = scene.borrow().hit(x, y);
                log(&format!("tap ({x},{y}) -> node {id}"));
                Some(format!(r#"{{"type":"tap","id":{id},"x":{x},"y":{y}}}"#))
            }
            Ok(Event::Key(code)) => {
                last_input = Instant::now();
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
            Ok(Event::PowerHeld(held)) => {
                // same as the :reload debug command: fetch app.js from update_url, then restart
                log(&format!("power held {}s: refetching the bundle", held.as_secs()));
                let _ = fs::write(HAPTIC, "1\n");
                let out = debug_command("reload");
                log(&format!("reload: {out}"));
                if !out.starts_with("ok") {
                    set_error(&mut fb.borrow_mut(), &out);
                }
                None
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
        }
        if !charging() && last_input.elapsed() >= IDLE_AFTER {
            sleep_cycle(&rx);
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
        let _ = writer.write_all(b"eink-host debug: type JS, get results; log lines stream here\n");
        if let Ok(mut c) = DEBUG_CLIENTS.lock() {
            c.push(writer.try_clone().unwrap());
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

fn update_url() -> String {
    // keys.conf: update_url=http://<mac-ip>:8787/  (a directory serving app.js and eink-host)
    fs::read_to_string(format!("{DIR}/keys.conf"))
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.trim().strip_prefix("update_url=").map(|v| v.trim().to_string())))
        .unwrap_or_else(|| String::from("http://192.168.0.144:8787/"))
}

fn download(url: &str) -> Result<Vec<u8>> {
    let resp = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build().get(url).call().with_context(|| format!("GET {url}"))?;
    let mut buf = Vec::new();
    resp.into_reader().read_to_end(&mut buf)?;
    Ok(buf)
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
///   :reload         fetch app.js from update_url and restart
///   :update         fetch eink-host from update_url, install, restart
///   :restart        restart with the current files
///   :exit           hand the screen back to the Kindle UI
///   :battery        battery + charger state
fn debug_command(cmd: &str) -> String {
    match cmd {
        "reload" => {
            let url = format!("{}app.js", update_url());
            match download(&url) {
                Ok(b) => {
                    if let Err(e) = fs::write(format!("{DIR}/app.js"), &b) {
                        return format!("downloaded {} bytes but could not write app.js: {e}", b.len());
                    }
                    log(&format!("reloaded app.js ({} bytes) from {url}", b.len()));
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_millis(300));
                        restart_self("/var/tmp/eink-host-run");
                    });
                    format!("ok, {} bytes; restarting", b.len())
                }
                Err(e) => format!("reload failed: {e:#}"),
            }
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
        "battery" => format!("charging={} {}", charging(), fs::read_to_string("/sys/devices/system/wario_battery/wario_battery0/battery_capacity").map(|s| s.trim().to_string() + "%").unwrap_or_default()),
        _ => "commands: :reload :update :restart :exit :battery".into(),
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
fn sleep_cycle(rx: &mpsc::Receiver<Event>) {
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
        // RTC wake: give the app a moment (its own timers can refresh data), then sleep again
        if let Ok(ev) = rx.recv_timeout(Duration::from_secs(20)) {
            if !matches!(ev, Event::Power(_) | Event::Eval(..) | Event::PowerHeld(..)) {
                break;
            }
        }
    }
    if let Some(v) = light {
        let _ = fs::write(FRONTLIGHT, format!("{v}\n"));
    }
}
