//! The synced repository: a git checkout under /var/local/eink-ui/repo, pulled and pushed by a
//! worker thread so the UI never waits on the network. The app reads and writes files through
//! `__eink.read_file` / `write_file`; a write is committed at once and pushed a few seconds later.
//! Transport is SSH through dropbear's client with a deploy key generated on the device.
use crate::{gh::{self, Github}, log, Event, DIR};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Tools and keys live on the small persistent partition; the checkout lives on user storage,
/// which has gigabytes, at the price of being unreachable while the cable exports it over USB.
pub const BASE: &str = "/var/local/eink-ui";
pub const REPO: &str = "/mnt/us/eink-ui/repo";
pub const REPO_PARENT: &str = "/mnt/us/eink-ui";
pub const TOOLS: &str = "/var/local/eink-ui/bin";
const OLD_REPO: &str = "/var/local/eink-ui/repo";
const KEY: &str = "/var/local/eink-ui/deploy_key";
/// Writes are committed together after this much quiet, pushed after a longer one, and no git
/// command runs within a few seconds of a tap: the UI and git share one core.
const COMMIT_QUIET: Duration = Duration::from_secs(5);
const PUSH_QUIET: Duration = Duration::from_secs(20);
const INPUT_QUIET: Duration = Duration::from_secs(3);
const INPUT_WAIT_CAP: Duration = Duration::from_secs(90);

static LAST_INPUT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn note_input() {
    LAST_INPUT_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

/// Blocks the worker until the user has left the device alone for a moment (bounded).
fn wait_for_quiet() {
    let started = Instant::now();
    loop {
        let since = now_ms().saturating_sub(LAST_INPUT_MS.load(std::sync::atomic::Ordering::Relaxed));
        if since >= INPUT_QUIET.as_millis() as u64 || started.elapsed() >= INPUT_WAIT_CAP {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[derive(Clone, Debug)]
pub struct SyncState {
    pub state: &'static str,
    pub pending: usize,
    pub last_sync: Option<u64>,
    pub error: Option<String>,
}

impl SyncState {
    pub fn json(&self) -> String {
        serde_json::json!({"state": self.state, "pending": self.pending, "last_sync": self.last_sync, "error": self.error}).to_string()
    }
}

pub enum SyncCmd {
    /// Pull, then push what is pending; the sender, if any, is told when it is done.
    Now(Option<mpsc::Sender<()>>),
    /// Commit one written file; a push follows after a short debounce.
    Commit(String),
    /// Write a file the app just changed, then treat it as Commit.
    Write(String, String),
}

pub struct Repo {
    pub url: String,
    pub branch: String,
}

fn keys_conf() -> String {
    fs::read_to_string(format!("{DIR}/keys.conf")).unwrap_or_default()
}

fn conf_value(key: &str) -> Option<String> {
    keys_conf().lines().find_map(|l| l.trim().strip_prefix(&format!("{key}=")).map(|v| v.trim().to_string())).filter(|v| !v.is_empty())
}

/// Where the files come from: GitHub over HTTPS (`repo_url=https://github.com/owner/repo` plus
/// `github_token=`), or any git remote over SSH through the bundled git (`repo_url=git@...`).
pub enum Remote {
    Git(Repo),
    Github(Github),
}

pub fn repo_url() -> Option<String> {
    conf_value("repo_url")
}

pub fn configured() -> bool {
    repo_url().is_some()
}

/// `Ok(None)` when no repository is configured; `Err` names what is missing.
pub fn config() -> Result<Option<Remote>, String> {
    let Some(url) = conf_value("repo_url") else { return Ok(None) };
    let branch = conf_value("repo_branch").unwrap_or_else(|| "main".into());
    if let Some((owner, repo)) = gh::parse(&url) {
        let token = conf_value("github_token").ok_or_else(|| "github_token missing in keys.conf (a fine-grained token with contents read/write on that repo)".to_string())?;
        return Ok(Some(Remote::Github(Github::new(owner, repo, branch, token))));
    }
    Ok(Some(Remote::Git(Repo { url, branch })))
}

/// Rewrites keys.conf with a new value for `key`, keeping every other line.
pub fn set_conf(key: &str, value: &str) -> std::io::Result<()> {
    let mut lines: Vec<String> = keys_conf().lines().filter(|l| !l.trim().starts_with(&format!("{key}="))).map(str::to_string).collect();
    if !value.is_empty() {
        lines.push(format!("{key}={value}"));
    }
    fs::write(format!("{DIR}/keys.conf"), lines.join("\n") + "\n")
}

fn sha256_file(p: &Path) -> Option<String> {
    use sha2::Digest;
    fs::read(p).ok().map(|d| format!("{:x}", sha2::Sha256::digest(d)))
}

/// Copies git and dropbear from the app directory (delivered by the store or USB) into
/// /var/local, which survives USB drive mode; returns true when both are present.
pub fn install_tools() -> bool {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::create_dir_all(TOOLS);
    let mut ready = true;
    for name in ["git", "dropbearmulti"] {
        let src = PathBuf::from(format!("{DIR}/bin/{name}"));
        let dst = PathBuf::from(format!("{TOOLS}/{name}"));
        if src.exists() && sha256_file(&src) != sha256_file(&dst) {
            match fs::copy(&src, &dst) {
                Ok(_) => {
                    let _ = fs::set_permissions(&dst, fs::Permissions::from_mode(0o755));
                    log(&format!("installed {name} into {TOOLS}"));
                }
                Err(e) => log(&format!("could not install {name}: {e}")),
            }
        }
        ready &= dst.exists();
    }
    ready
}

/// Frees the small partition of a checkout from an earlier layout.
pub fn remove_old_checkout() {
    if Path::new(OLD_REPO).exists() {
        let _ = fs::remove_dir_all(OLD_REPO);
        log(&format!("removed the old checkout at {OLD_REPO}; {} MiB free on {BASE}", free_mib_at(BASE)));
    }
}

pub fn free_mib_at(dir: &str) -> u64 {
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        let path = std::ffi::CString::new(dir).unwrap();
        if libc::statvfs(path.as_ptr(), &mut st) != 0 {
            return u64::MAX;
        }
        (st.f_bavail as u64 * st.f_frsize as u64) / (1024 * 1024)
    }
}

/// Free space on the partition holding the checkout, in MiB.
pub fn free_mib() -> u64 {
    let _ = fs::create_dir_all(REPO_PARENT);
    free_mib_at(REPO_PARENT)
}

const MIN_FREE_MIB: u64 = 64;

fn looks_corrupt(e: &anyhow::Error) -> bool {
    let t = format!("{e:#}");
    t.contains("corrupt") || t.contains("unable to unpack") || t.contains("not a git repository") || t.contains("inflate") || t.contains("bad object")
}

pub fn tools_ready() -> bool {
    Path::new(&format!("{TOOLS}/git")).exists() && Path::new(&format!("{TOOLS}/dropbearmulti")).exists()
}

/// The deploy key's public half, generating the key on first use.
pub fn public_key() -> Result<String> {
    let dropbear = format!("{TOOLS}/dropbearmulti");
    if !Path::new(KEY).exists() {
        let _ = fs::create_dir_all(BASE);
        let out = Command::new(&dropbear).args(["dropbearkey", "-t", "ed25519", "-f", KEY]).output().context("dropbearkey")?;
        if !out.status.success() {
            bail!("dropbearkey failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
    }
    let out = Command::new(&dropbear).args(["dropbearkey", "-y", "-f", KEY]).output().context("dropbearkey -y")?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.starts_with("ssh-"))
        .map(|l| l.trim().to_string())
        .context("no public key in dropbearkey output")
}

/// Repository-relative, forward-slash, no traversal, never inside .git.
pub fn safe_path(rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || rel.contains('\0') || rel.split('/').any(|c| c.is_empty() || c == "." || c == "..") || rel == ".git" || rel.starts_with(".git/") {
        return None;
    }
    Some(Path::new(REPO).join(rel))
}

pub fn read_file(rel: &str) -> Option<String> {
    fs::read_to_string(safe_path(rel)?).ok()
}

pub fn write_file(rel: &str, text: &str) -> Result<()> {
    let p = safe_path(rel).context("bad path")?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("part");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &p)?;
    Ok(())
}

pub fn list_files(prefix: &str) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            if p.is_dir() {
                walk(&p, root, out);
            } else if let Ok(rel) = p.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if !rel.starts_with(".eink-") && !rel.ends_with(".part") {
                    out.push(rel);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(Path::new(REPO), Path::new(REPO), &mut out);
    let prefix = prefix.trim_start_matches('/');
    out.retain(|p| p.starts_with(prefix));
    out.sort();
    out
}

impl Repo {
    fn git_in(&self, dir: &str, args: &[&str]) -> Result<String> {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(format!("{TOOLS}/git"));
        // git and the ssh client it spawns share one core with the UI: keep them polite
        unsafe {
            cmd.pre_exec(|| {
                libc::setpriority(libc::PRIO_PROCESS, 0, 15);
                Ok(())
            });
        }
        let out = cmd
            .args(args)
            .current_dir(dir)
            .env("HOME", BASE)
            .env("GIT_EXEC_PATH", TOOLS)
            .env("GIT_TEMPLATE_DIR", "")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SSH_COMMAND", format!("{TOOLS}/dropbearmulti dbclient -i {KEY} -y -y"))
            .output()
            .with_context(|| format!("run git {}", args.join(" ")))?;
        if !out.status.success() {
            bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn git(&self, args: &[&str]) -> Result<String> {
        self.git_in(REPO, args)
    }

    fn remote(&self) -> String {
        format!("origin/{}", self.branch)
    }

    /// Throws the checkout away and clones again: the cure for a truncated object after a full
    /// disk or a suspend mid-write. Local commits are lost, they were checkbox flips.
    fn reclone(&self) -> Result<()> {
        log("repo: checkout is corrupt, cloning again");
        let _ = fs::remove_dir_all(REPO);
        self.ensure_clone().map(|_| ())
    }

    /// Keeps the checkout small: the device needs the current tree, not the history of 4 MB
    /// binaries. Runs after a pull that changed something.
    fn prune(&self) {
        let _ = self.git(&["reflog", "expire", "--expire=now", "--all"]);
        if let Err(e) = self.git(&["gc", "-q", "--prune=now"]) {
            log(&format!("repo: gc failed: {e:#}"));
        }
    }

    /// Clones on first use; returns true when it did.
    fn ensure_clone(&self) -> Result<bool> {
        if Path::new(REPO).join(".git").exists() {
            return Ok(false);
        }
        let free = free_mib();
        if free < MIN_FREE_MIB {
            bail!("{free} MiB free on {REPO_PARENT}, not cloning");
        }
        fs::create_dir_all(REPO_PARENT)?;
        log(&format!("repo: cloning {}", self.url));
        self.git_in(REPO_PARENT, &["clone", "--depth", "1", "--branch", &self.branch, &self.url, REPO])?;
        self.git(&["config", "user.name", "kindle"])?;
        self.git(&["config", "user.email", "kindle@eink-ui"])?;
        Ok(true)
    }

    pub fn pending(&self) -> usize {
        self.git(&["rev-list", "--count", &format!("{}..HEAD", self.remote())]).ok().and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    fn commit_all(&self, message: &str) -> Result<bool> {
        self.git(&["add", "-A"])?;
        if self.git(&["diff", "--cached", "--quiet"]).is_ok() {
            return Ok(false);
        }
        self.git(&["commit", "-q", "-m", message])?;
        Ok(true)
    }

    pub fn commit(&self, rel: &str, message: &str) -> Result<bool> {
        self.git(&["add", "--", rel])?;
        if self.git(&["diff", "--cached", "--quiet", "--", rel]).is_ok() {
            return Ok(false);
        }
        self.git(&["commit", "-q", "-m", message])?;
        Ok(true)
    }

    /// Fetches and moves to the remote tip, replaying local commits on top; a conflict keeps the
    /// remote version and drops the local commits (they were single checkbox flips). Returns the
    /// paths that changed on disk.
    pub fn pull(&self) -> Result<Vec<String>> {
        let free = free_mib();
        if free < MIN_FREE_MIB {
            bail!("{free} MiB free on {REPO_PARENT}, not pulling");
        }
        let _ = self.commit_all("kindle: autosave");
        let before = match self.git(&["rev-parse", "HEAD"]) {
            Ok(h) => h,
            Err(e) if looks_corrupt(&e) => {
                self.reclone()?;
                return Ok(list_files(""));
            }
            Err(e) => return Err(e),
        };
        if let Err(e) = self.git(&["fetch", "-q", "origin", &self.branch]) {
            if looks_corrupt(&e) {
                self.reclone()?;
                return Ok(list_files(""));
            }
            return Err(e);
        }
        let remote = self.remote();
        if self.pending() > 0 {
            if let Err(e) = self.git(&["rebase", "-q", &remote]) {
                log(&format!("repo: rebase failed, keeping the remote version: {e:#}"));
                let _ = self.git(&["rebase", "--abort"]);
                self.git(&["reset", "-q", "--hard", &remote])?;
            }
        } else {
            self.git(&["reset", "-q", "--hard", &remote])?;
        }
        let after = self.git(&["rev-parse", "HEAD"])?;
        if before == after {
            return Ok(Vec::new());
        }
        let changed: Vec<String> = self.git(&["diff", "--name-only", &before, &after])?.lines().map(str::to_string).filter(|s| !s.is_empty()).collect();
        self.prune();
        log(&format!("repo: {} MiB free after pull", free_mib()));
        Ok(changed)
    }

    pub fn push(&self) -> Result<()> {
        let spec = format!("HEAD:{}", self.branch);
        if let Err(e) = self.git(&["push", "-q", "origin", &spec]) {
            log(&format!("repo: push rejected, pulling first: {e:#}"));
            self.pull()?;
            self.git(&["push", "-q", "origin", &spec])?;
        }
        Ok(())
    }
}

fn commit_message(paths: &std::collections::BTreeSet<String>) -> String {
    match paths.len() {
        1 => format!("kindle: {}", paths.iter().next().unwrap()),
        n => format!("kindle: {n} files"),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The worker: owns the git operations, reports state and changed files as events.
pub fn start(tx: mpsc::Sender<Event>) -> (mpsc::Sender<SyncCmd>, Arc<Mutex<SyncState>>) {
    let (ctx, crx) = mpsc::channel::<SyncCmd>();
    let shared = Arc::new(Mutex::new(SyncState { state: "offline", pending: 0, last_sync: None, error: None }));
    let state = shared.clone();
    std::thread::spawn(move || {
        let publish = |s: SyncState| {
            if let Ok(mut g) = state.lock() {
                *g = s.clone();
            }
            let _ = tx.send(Event::SyncState(s));
        };
        let mut last_sync: Option<u64> = None;
        let mut commit_due: Option<Instant> = None;
        let mut push_due: Option<Instant> = None;
        let mut dirty: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        loop {
            let next_due = match (commit_due, push_due) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let cmd = match next_due {
                Some(t) => match crx.recv_timeout(t.saturating_duration_since(Instant::now())) {
                    Ok(c) => Some(c),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                },
                None => match crx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => return,
                },
            };
            if let Some(SyncCmd::Write(path, text)) = &cmd {
                if config().ok().flatten().is_none() {
                    if let Err(e) = write_file(path, text) {
                        log(&format!("write_file {path}: {e:#}"));
                    }
                    continue;
                }
            }
            let remote = match config() {
                Ok(Some(r)) => r,
                Ok(None) | Err(_) => {
                    let why = match config() { Err(e) => e, _ => "no repo_url in keys.conf".into() };
                    publish(SyncState { state: "offline", pending: 0, last_sync, error: Some(why) });
                    if let Some(SyncCmd::Now(Some(ack))) = cmd {
                        let _ = ack.send(());
                    }
                    continue;
                }
            };
            if matches!(remote, Remote::Git(_)) && !tools_ready() {
                publish(SyncState { state: "offline", pending: 0, last_sync, error: Some("git or dropbear missing".into()) });
                if let Some(SyncCmd::Now(Some(ack))) = cmd {
                    let _ = ack.send(());
                }
                continue;
            }
            let pending = |dirty: &std::collections::BTreeSet<String>| match &remote {
                Remote::Git(repo) => repo.pending(),
                Remote::Github(_) => dirty.len(),
            };
            match cmd {
                Some(SyncCmd::Write(path, text)) => {
                    match write_file(&path, &text) {
                        Ok(()) => {
                            dirty.insert(path);
                            commit_due = Some(Instant::now() + COMMIT_QUIET);
                        }
                        Err(e) => log(&format!("write_file {path}: {e:#}")),
                    }
                }
                Some(SyncCmd::Commit(path)) => {
                    // the file is already on disk; the network runs once the user pauses
                    dirty.insert(path);
                    commit_due = Some(Instant::now() + COMMIT_QUIET);
                }
                Some(SyncCmd::Now(ack)) => {
                    if ack.is_none() {
                        wait_for_quiet();
                    }
                    publish(SyncState { state: "syncing", pending: pending(&dirty), last_sync, error: None });
                    let result: Result<Vec<String>> = match &remote {
                        Remote::Git(repo) => repo.ensure_clone().and_then(|fresh| {
                            if !dirty.is_empty() {
                                let _ = repo.commit_all(&commit_message(&dirty));
                                dirty.clear();
                                commit_due = None;
                            }
                            let changed = if fresh { list_files("") } else { repo.pull()? };
                            if repo.pending() > 0 {
                                repo.push()?;
                            }
                            Ok(changed)
                        }),
                        Remote::Github(gh) => gh.pull().and_then(|changed| {
                            for path in dirty.clone() {
                                gh.put(&path, &format!("kindle: {path}"))?;
                                dirty.remove(&path);
                            }
                            commit_due = None;
                            Ok(changed)
                        }),
                    };
                    match result {
                        Ok(changed) => {
                            last_sync = Some(now_ms());
                            push_due = None;
                            if !changed.is_empty() {
                                log(&format!("repo: {} file(s) changed", changed.len()));
                                let _ = tx.send(Event::Files(changed));
                            }
                            publish(SyncState { state: "idle", pending: pending(&dirty), last_sync, error: None });
                        }
                        Err(e) => {
                            log(&format!("repo: sync failed: {e:#}"));
                            publish(SyncState { state: "error", pending: pending(&dirty), last_sync, error: Some(format!("{e:#}")) });
                        }
                    }
                    if let Some(ack) = ack {
                        let _ = ack.send(());
                    }
                }
                None => {
                    let now = Instant::now();
                    if commit_due.is_some_and(|t| t <= now) {
                        commit_due = None;
                        wait_for_quiet();
                        match &remote {
                            Remote::Git(repo) => match repo.ensure_clone().and_then(|_| repo.commit_all(&commit_message(&dirty))) {
                                Ok(true) => {
                                    dirty.clear();
                                    push_due = Some(Instant::now() + PUSH_QUIET);
                                    publish(SyncState { state: "idle", pending: repo.pending(), last_sync, error: None });
                                }
                                Ok(false) => dirty.clear(),
                                Err(e) => publish(SyncState { state: "error", pending: repo.pending(), last_sync, error: Some(format!("{e:#}")) }),
                            },
                            Remote::Github(gh) => {
                                // each put is a commit on GitHub already: nothing left to push
                                let mut failed = None;
                                for path in dirty.clone() {
                                    match gh.put(&path, &format!("kindle: {path}")) {
                                        Ok(()) => { dirty.remove(&path); }
                                        Err(e) => { failed = Some(format!("{e:#}")); break; }
                                    }
                                }
                                match failed {
                                    None => {
                                        last_sync = Some(now_ms());
                                        publish(SyncState { state: "idle", pending: dirty.len(), last_sync, error: None });
                                    }
                                    Some(e) => {
                                        log(&format!("repo: put failed: {e}"));
                                        commit_due = Some(Instant::now() + PUSH_QUIET);
                                        publish(SyncState { state: "error", pending: dirty.len(), last_sync, error: Some(e) });
                                    }
                                }
                            }
                        }
                    }
                    if push_due.is_some_and(|t| t <= Instant::now()) {
                        push_due = None;
                        if let Remote::Git(repo) = &remote {
                            wait_for_quiet();
                            match repo.push() {
                                Ok(()) => {
                                    last_sync = Some(now_ms());
                                    publish(SyncState { state: "idle", pending: repo.pending(), last_sync, error: None });
                                }
                                Err(e) => {
                                    log(&format!("repo: push failed: {e:#}"));
                                    publish(SyncState { state: "error", pending: repo.pending(), last_sync, error: Some(format!("{e:#}")) });
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    (ctx, shared)
}
