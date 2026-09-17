//! The synced repository: a git checkout under /var/local/eink-ui/repo, pulled and pushed by a
//! worker thread so the UI never waits on the network. The app reads and writes files through
//! `__eink.read_file` / `write_file`; a write is committed at once and pushed a few seconds later.
//! Transport is SSH through dropbear's client with a deploy key generated on the device.
use crate::{log, Event, DIR};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const BASE: &str = "/var/local/eink-ui";
pub const REPO: &str = "/var/local/eink-ui/repo";
pub const TOOLS: &str = "/var/local/eink-ui/bin";
const KEY: &str = "/var/local/eink-ui/deploy_key";
const PUSH_DEBOUNCE: Duration = Duration::from_secs(3);

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

/// `repo_url=git@github.com:owner/repo.git` (and optional `repo_branch=`) in keys.conf.
pub fn config() -> Option<Repo> {
    Some(Repo { url: conf_value("repo_url")?, branch: conf_value("repo_branch").unwrap_or_else(|| "main".into()) })
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
                out.push(rel.to_string_lossy().replace('\\', "/"));
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
        let out = Command::new(format!("{TOOLS}/git"))
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

    /// Clones on first use; returns true when it did.
    fn ensure_clone(&self) -> Result<bool> {
        if Path::new(REPO).join(".git").exists() {
            return Ok(false);
        }
        fs::create_dir_all(BASE)?;
        log(&format!("repo: cloning {}", self.url));
        self.git_in(BASE, &["clone", "--depth", "1", "--branch", &self.branch, &self.url, REPO])?;
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
        let _ = self.commit_all("kindle: autosave");
        let before = self.git(&["rev-parse", "HEAD"])?;
        self.git(&["fetch", "-q", "origin", &self.branch])?;
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
        Ok(self.git(&["diff", "--name-only", &before, &after])?.lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
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
        let mut push_due: Option<Instant> = None;
        loop {
            let cmd = match push_due {
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
            let Some(repo) = config() else {
                publish(SyncState { state: "offline", pending: 0, last_sync, error: Some("no repo_url in keys.conf".into()) });
                if let Some(SyncCmd::Now(Some(ack))) = cmd {
                    let _ = ack.send(());
                }
                continue;
            };
            if !tools_ready() {
                publish(SyncState { state: "offline", pending: 0, last_sync, error: Some("git or dropbear missing".into()) });
                if let Some(SyncCmd::Now(Some(ack))) = cmd {
                    let _ = ack.send(());
                }
                continue;
            }
            match cmd {
                Some(SyncCmd::Commit(path)) => {
                    match repo.ensure_clone().and_then(|_| repo.commit(&path, &format!("kindle: {path}"))) {
                        Ok(true) => {
                            push_due = Some(Instant::now() + PUSH_DEBOUNCE);
                            publish(SyncState { state: "idle", pending: repo.pending(), last_sync, error: None });
                        }
                        Ok(false) => {}
                        Err(e) => publish(SyncState { state: "error", pending: repo.pending(), last_sync, error: Some(format!("{e:#}")) }),
                    }
                }
                Some(SyncCmd::Now(ack)) => {
                    publish(SyncState { state: "syncing", pending: repo.pending(), last_sync, error: None });
                    let result = repo.ensure_clone().and_then(|fresh| {
                        let changed = if fresh { list_files("") } else { repo.pull()? };
                        if repo.pending() > 0 {
                            repo.push()?;
                        }
                        Ok(changed)
                    });
                    match result {
                        Ok(changed) => {
                            last_sync = Some(now_ms());
                            push_due = None;
                            if !changed.is_empty() {
                                log(&format!("repo: {} file(s) changed", changed.len()));
                                let _ = tx.send(Event::Files(changed));
                            }
                            publish(SyncState { state: "idle", pending: repo.pending(), last_sync, error: None });
                        }
                        Err(e) => {
                            log(&format!("repo: sync failed: {e:#}"));
                            publish(SyncState { state: "error", pending: repo.pending(), last_sync, error: Some(format!("{e:#}")) });
                        }
                    }
                    if let Some(ack) = ack {
                        let _ = ack.send(());
                    }
                }
                None => {
                    // debounce elapsed: push what accumulated
                    push_due = None;
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
    });
    (ctx, shared)
}
