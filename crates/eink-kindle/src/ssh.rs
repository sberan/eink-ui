//! SSH into the device: a dropbear server that the host starts, key-only, with the authorized
//! keys fetched from GitHub (`https://github.com/<user>.keys`), so whoever can push to the
//! repository can also log in. In the manifest, `ssh.enabled: false` disables it and
//! `ssh.users: ["alice", "bob"]` names the GitHub accounts (default: the owner of `repo_url`).
use crate::repo::{self, TOOLS};
use crate::{bg, log};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::Duration,
};

pub const PORT: u16 = 22;
pub const DIR: &str = "/var/local/eink-ui/ssh";
const HOST_KEY: &str = "/var/local/eink-ui/ssh/host_ed25519";
const KEYS: &str = "/var/local/eink-ui/ssh/authorized_keys";
const PIDFILE: &str = "/var/tmp/eink-dropbear.pid";
const LOG: &str = "/var/tmp/eink-dropbear.log";
const REFRESH: Duration = Duration::from_secs(15 * 60);
const RETRY: Duration = Duration::from_secs(30);

/// The last logged outcome, shown by `:ssh` and used to keep retries quiet.
static LAST: Mutex<String> = Mutex::new(String::new());
static SUPERVISING: AtomicBool = AtomicBool::new(false);

fn dropbear() -> String {
    format!("{TOOLS}/dropbearmulti")
}

pub fn enabled() -> bool {
    crate::manifest::flag(&["ssh", "enabled"], true)
}

/// GitHub accounts whose keys may log in: `ssh.users` in the manifest, else the owner of `repo_url`.
pub fn users() -> Vec<String> {
    if let Some(list) = crate::manifest::list(&["ssh", "users"]) {
        let users: Vec<String> = list.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        if !users.is_empty() {
            return users;
        }
    }
    repo::repo_url().and_then(|u| github_owner(&u)).into_iter().collect()
}

fn github_owner(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("github:"))
        .or_else(|| url.strip_prefix("git@github.com:"))?;
    let owner = rest.split('/').next()?.trim();
    (!owner.is_empty()).then(|| owner.to_string())
}

/// Root's home as dropbear will see it (`getpwnam`): `/tmp/root` on the Kindle.
fn root_home() -> String {
    fs::read_to_string("/etc/passwd").ok().and_then(|p| home_from_passwd(&p)).unwrap_or_else(|| "/root".into())
}

fn home_from_passwd(passwd: &str) -> Option<String> {
    let line = passwd.lines().find(|l| l.starts_with("root:"))?;
    let home = line.split(':').nth(5)?.trim();
    (!home.is_empty()).then(|| home.to_string())
}

fn server_args() -> Vec<String> {
    ["dropbear", "-F", "-E", "-r", HOST_KEY, "-p", &PORT.to_string(), "-P", PIDFILE].iter().map(|s| s.to_string()).collect()
}

/// The running server's pid and whether it was started with the current arguments: a host
/// restart leaves the previous server alive, possibly with an older configuration.
fn server() -> Option<(i32, bool)> {
    let pid: i32 = fs::read_to_string(PIDFILE).ok()?.trim().parse().ok()?;
    let cmdline = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let argv: Vec<String> = cmdline.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    if !argv.iter().any(|a| a.contains("dropbear")) {
        return None;
    }
    Some((pid, argv.len() > 1 && argv[1..] == server_args()[..]))
}

fn pid() -> Option<i32> {
    server().map(|(p, _)| p)
}

pub fn running() -> bool {
    pid().is_some()
}

/// Ends a server started with other arguments and waits for it to go, so the port is free.
fn retire_stale() {
    if let Some((p, current)) = server() {
        if current {
            return;
        }
        log(&format!("ssh: server {p} runs with old arguments; restarting it"));
        unsafe {
            libc::kill(p, libc::SIGTERM);
        }
        for _ in 0..30 {
            if !Path::new(&format!("/proc/{p}")).exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = fs::remove_file(PIDFILE);
    }
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{program} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn chmod(path: &str, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

fn group_or_world_writable(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).map(|m| m.permissions().mode() & 0o022 != 0).unwrap_or(false)
}

/// Copies the fetched keys into root's `~/.ssh`. dropbear checks the permissions of every
/// directory above `authorized_keys` and only stops at the home directory, so a file under
/// `/var/local` would fail on whatever the mount point or the launcher's umask allows; the home
/// is a tmpfs path here, hence the copy at every start.
fn install_keys() -> Result<(), String> {
    let home = root_home();
    if !Path::new(&home).exists() {
        fs::create_dir_all(&home).map_err(|e| format!("{home}: {e}"))?;
        chmod(&home, 0o700);
    } else if group_or_world_writable(&home) {
        chmod(&home, 0o755);
    }
    let dir = format!("{home}/.ssh");
    fs::create_dir_all(&dir).map_err(|e| format!("{dir}: {e}"))?;
    chmod(&dir, 0o700);
    let live = format!("{dir}/authorized_keys");
    let keys = fs::read_to_string(KEYS).unwrap_or_default();
    if fs::read_to_string(&live).ok().as_deref() != Some(keys.as_str()) {
        let tmp = format!("{live}.tmp");
        fs::write(&tmp, &keys).map_err(|e| format!("{tmp}: {e}"))?;
        chmod(&tmp, 0o600);
        fs::rename(&tmp, &live).map_err(|e| format!("{live}: {e}"))?;
    }
    Ok(())
}

/// Runs the server in the foreground under a thread that logs its output and restarts it
/// while SSH stays enabled.
fn supervise(db: String) {
    if SUPERVISING.swap(true, Ordering::SeqCst) {
        return;
    }
    bg(move || {
        loop {
            if fs::metadata(LOG).map(|m| m.len() > 200_000).unwrap_or(false) {
                let _ = fs::remove_file(LOG);
            }
            let mut cmd = Command::new(&db);
            cmd.args(server_args()).stdin(Stdio::null()).stdout(Stdio::null());
            match fs::OpenOptions::new().create(true).append(true).open(LOG) {
                Ok(f) => {
                    cmd.stderr(f);
                }
                Err(_) => {
                    cmd.stderr(Stdio::null());
                }
            }
            match cmd.status() {
                Ok(st) => log(&format!("ssh: server exited ({st})")),
                Err(e) => log(&format!("ssh: server did not start: {e}")),
            }
            let _ = fs::remove_file(PIDFILE);
            if !enabled() {
                break;
            }
            std::thread::sleep(Duration::from_secs(5));
        }
        SUPERVISING.store(false, Ordering::SeqCst);
    });
}

/// Starts the server when it is not running; the host key is made on first use. Sessions get
/// dropbear's fixed root PATH, so `scp` is linked once into the read-only rootfs.
pub fn ensure() -> Result<(), String> {
    let db = dropbear();
    if !Path::new(&db).exists() {
        return Err("dropbearmulti is not installed".into());
    }
    fs::create_dir_all(DIR).map_err(|e| format!("{DIR}: {e}"))?;
    chmod(DIR, 0o700);
    if !Path::new(HOST_KEY).exists() {
        run(&db, &["dropbearkey", "-t", "ed25519", "-f", HOST_KEY])?;
    }
    if !Path::new(KEYS).exists() {
        fs::write(KEYS, "").map_err(|e| format!("{KEYS}: {e}"))?;
    }
    chmod(KEYS, 0o600);
    install_keys()?;
    // scp and the `eink` command need names on the login shell's fixed PATH, which is on the
    // read-only rootfs: linked once
    let me = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
    let mut links: Vec<(&str, String)> = vec![("/usr/bin/scp", db.clone())];
    if let Some(me) = me {
        links.push(("/usr/bin/eink", me));
    }
    let missing: Vec<(&str, String)> = links.into_iter().filter(|(at, to)| fs::read_link(at).map(|l| l.to_string_lossy() != to.as_str()).unwrap_or(true)).collect();
    if !missing.is_empty() {
        let linked = run("/usr/sbin/mntroot", &["rw"]).and_then(|_| {
            for (at, to) in &missing {
                let _ = fs::remove_file(at);
                std::os::unix::fs::symlink(to, at).map_err(|e| format!("link {at}: {e}"))?;
            }
            Ok(String::new())
        });
        let _ = run("/usr/sbin/mntroot", &["ro"]);
        match linked {
            Ok(_) => log(&format!("ssh: linked {}", missing.iter().map(|(a, _)| *a).collect::<Vec<_>>().join(", "))),
            Err(e) => log(&format!("ssh: {e}")),
        }
    }
    crate::open_port(PORT);
    retire_stale();
    if running() {
        return Ok(());
    }
    supervise(db);
    log(&format!("ssh: listening on :{PORT}"));
    Ok(())
}

pub fn stop() {
    if let Some(p) = pid() {
        unsafe {
            libc::kill(p, libc::SIGTERM);
        }
        log("ssh: stopped");
    }
    crate::close_port(PORT);
}

fn looks_like_key(line: &str) -> bool {
    let mut it = line.split_whitespace();
    matches!((it.next(), it.next()), (Some(t), Some(b))
        if (t.starts_with("ssh-") || t.starts_with("ecdsa-") || t.starts_with("sk-")) && b.len() > 16)
}

/// Rewrites the keys from GitHub. Every account must answer, or the file is left as it is, so
/// a flaky network never revokes anything; a key removed on GitHub is gone at the next refresh.
pub fn refresh() -> Result<String, String> {
    let users = users();
    if users.is_empty() {
        return Err("no ssh.users in the manifest and no GitHub repo_url in keys.conf".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    let mut keys = String::new();
    let mut n = 0;
    for u in &users {
        let body = agent
            .get(&format!("https://github.com/{u}.keys"))
            .call()
            .map_err(|e| format!("{u}: {e}"))?
            .into_string()
            .map_err(|e| format!("{u}: {e}"))?;
        for k in body.lines().map(str::trim).filter(|l| looks_like_key(l)) {
            keys.push_str(&format!("{k} github:{u}\n"));
            n += 1;
        }
    }
    let changed = fs::read_to_string(KEYS).ok().as_deref() != Some(keys.as_str());
    if changed {
        let tmp = format!("{KEYS}.tmp");
        fs::write(&tmp, &keys).map_err(|e| format!("{tmp}: {e}"))?;
        chmod(&tmp, 0o600);
        fs::rename(&tmp, KEYS).map_err(|e| format!("{KEYS}: {e}"))?;
    }
    install_keys()?;
    let who = users.iter().map(|u| format!("github:{u}")).collect::<Vec<_>>().join(", ");
    Ok(format!("{n} key(s) from {who}{}", if changed { ", updated" } else { "" }))
}

/// Fingerprint of the host key, to check against the first `ssh` from a laptop.
pub fn fingerprint() -> Option<String> {
    let out = run(&dropbear(), &["dropbearkey", "-y", "-f", HOST_KEY]).ok()?;
    out.lines().find_map(|l| l.trim().strip_prefix("Fingerprint:").map(|f| f.trim().to_string()))
}

pub fn status() -> String {
    let state = match pid() {
        Some(p) => format!("running (pid {p}) on :{PORT}"),
        None if enabled() => "not running".to_string(),
        None => "off (ssh.enabled is false in the manifest)".to_string(),
    };
    let count = fs::read_to_string(KEYS).map(|s| s.lines().filter(|l| looks_like_key(l)).count()).unwrap_or(0);
    let last = LAST.lock().map(|g| g.clone()).unwrap_or_default();
    let tail = fs::read_to_string(LOG)
        .map(|s| s.lines().rev().take(2).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    format!(
        "ssh: {state}; {count} authorized key(s) for {} in {}/.ssh; scp {}; host key {}; last: {}; server log: {}",
        users().join(","),
        root_home(),
        if Path::new("/usr/bin/scp").exists() { "linked" } else { "missing" },
        fingerprint().unwrap_or_else(|| "?".into()),
        if last.is_empty() { "nothing yet" } else { &last },
        if tail.is_empty() { "(empty)".to_string() } else { tail.join(" | ") },
    )
}

/// Logs a message only when it differs from the last one, so retries before Wi-Fi is up stay quiet.
fn note(msg: &str) {
    if let Ok(mut g) = LAST.lock() {
        if *g != msg {
            log(msg);
            *g = msg.to_string();
        }
    }
}

/// Keeps the server up and the keys fresh: at start, then every 15 minutes while awake.
pub fn start() {
    bg(|| loop {
        if !enabled() {
            if running() {
                stop();
            }
            std::thread::sleep(REFRESH);
            continue;
        }
        if let Err(e) = ensure() {
            note(&format!("ssh: {e}"));
            std::thread::sleep(RETRY);
            continue;
        }
        match refresh() {
            Ok(s) => {
                note(&format!("ssh: {s}"));
                std::thread::sleep(REFRESH);
            }
            Err(e) => {
                note(&format!("ssh: keys not refreshed: {e}"));
                std::thread::sleep(RETRY);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_from_every_github_url_form() {
        assert_eq!(github_owner("https://github.com/sberan/kindle").as_deref(), Some("sberan"));
        assert_eq!(github_owner("github:sberan/kindle").as_deref(), Some("sberan"));
        assert_eq!(github_owner("git@github.com:sberan/kindle.git").as_deref(), Some("sberan"));
        assert_eq!(github_owner("git@example.com:sberan/kindle.git"), None);
    }

    #[test]
    fn only_key_lines_are_kept() {
        assert!(looks_like_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2g"));
        assert!(looks_like_key("sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t"));
        assert!(!looks_like_key("<html>not found</html>"));
        assert!(!looks_like_key("ssh-rsa"));
        assert!(!looks_like_key(""));
    }

    #[test]
    fn root_home_comes_from_passwd() {
        let passwd = "root:x:0:0:root:/tmp/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/bin/sh\n";
        assert_eq!(home_from_passwd(passwd).as_deref(), Some("/tmp/root"));
        assert_eq!(home_from_passwd("nobody:x:99:99:nobody:/tmp:/bin/sh\n"), None);
    }
}
