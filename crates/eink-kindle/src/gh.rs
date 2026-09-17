//! The lightweight sync: git stays on GitHub, the device speaks a handful of HTTPS calls.
//! A pull is one ETag-guarded request while nothing changed; when the branch moved, one tree
//! listing and a download per changed file. A write is one `PUT` that GitHub turns into a
//! commit. No packs, no compression, no SSH, no child processes.
use crate::{log, repo::{safe_path, REPO, REPO_PARENT}};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::Read, path::Path, time::Duration};

const API: &str = "https://api.github.com";
const INDEX: &str = ".eink-index.json";

pub struct Github {
    owner: String,
    repo: String,
    branch: String,
    token: String,
}

#[derive(Default)]
struct Index {
    head: String,
    etag: String,
    files: BTreeMap<String, String>,
}

impl Index {
    fn load() -> Index {
        let v: Value = fs::read_to_string(format!("{REPO}/{INDEX}")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        Index {
            head: v["head"].as_str().unwrap_or("").to_string(),
            etag: v["etag"].as_str().unwrap_or("").to_string(),
            files: v["files"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default(),
        }
    }
    fn save(&self) -> Result<()> {
        fs::create_dir_all(REPO)?;
        let tmp = format!("{REPO}/{INDEX}.part");
        fs::write(&tmp, json!({"head": self.head, "etag": self.etag, "files": self.files}).to_string())?;
        fs::rename(&tmp, format!("{REPO}/{INDEX}"))?;
        Ok(())
    }
}

/// `https://github.com/owner/repo(.git)` or `github:owner/repo`.
pub fn parse(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://github.com/").or_else(|| url.strip_prefix("github:"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let (owner, repo) = rest.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

struct Reply {
    status: u16,
    etag: Option<String>,
    body: Vec<u8>,
}

impl Github {
    pub fn new(owner: String, repo: String, branch: String, token: String) -> Github {
        Github { owner, repo, branch, token }
    }

    fn url(&self, path: &str) -> String {
        format!("{API}/repos/{}/{}{path}", self.owner, self.repo)
    }

    fn call(&self, method: &str, url: &str, accept: &str, etag: Option<&str>, body: Option<&Value>) -> Result<Reply> {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
        let mut req = agent.request(method, url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Accept", accept)
            .set("User-Agent", "eink-host")
            .set("X-GitHub-Api-Version", "2022-11-28");
        if let Some(e) = etag {
            req = req.set("If-None-Match", e);
        }
        let resp = match body {
            Some(b) => req.send_string(&b.to_string()),
            None => req.call(),
        };
        let resp = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => bail!("{method} {url}: {e}"),
        };
        let status = resp.status();
        let etag = resp.header("ETag").map(str::to_string);
        let mut bytes = Vec::new();
        resp.into_reader().read_to_end(&mut bytes)?;
        Ok(Reply { status, etag, body: bytes })
    }

    fn json(&self, method: &str, path: &str, etag: Option<&str>, body: Option<&Value>) -> Result<(u16, Option<String>, Value)> {
        let r = self.call(method, &self.url(path), "application/vnd.github+json", etag, body)?;
        let v: Value = if r.body.is_empty() { Value::Null } else { serde_json::from_slice(&r.body).unwrap_or(Value::Null) };
        Ok((r.status, r.etag, v))
    }

    fn fail(status: u16, v: &Value, what: &str) -> anyhow::Error {
        anyhow::anyhow!("{what}: HTTP {status} {}", v["message"].as_str().unwrap_or(""))
    }

    /// Brings the checkout up to the branch tip; returns the paths that changed on disk.
    pub fn pull(&self) -> Result<Vec<String>> {
        let mut index = Index::load();
        let (status, etag, branch) = self.json("GET", &format!("/branches/{}", self.branch), if index.etag.is_empty() { None } else { Some(&index.etag) }, None)?;
        if status == 304 {
            return Ok(Vec::new());
        }
        if status != 200 {
            bail!("{}", Self::fail(status, &branch, "branch"));
        }
        let head = branch["commit"]["sha"].as_str().context("branch has no commit sha")?.to_string();
        if let Some(e) = etag {
            index.etag = e;
        }
        if head == index.head {
            index.save()?;
            return Ok(Vec::new());
        }
        let (status, _, tree) = self.json("GET", &format!("/git/trees/{head}?recursive=1"), None, None)?;
        if status != 200 {
            bail!("{}", Self::fail(status, &tree, "tree"));
        }
        if tree["truncated"].as_bool().unwrap_or(false) {
            bail!("tree listing truncated: repository too large for this sync");
        }
        let mut remote: BTreeMap<String, String> = BTreeMap::new();
        for e in tree["tree"].as_array().into_iter().flatten() {
            if e["type"].as_str() == Some("blob") {
                if let (Some(p), Some(s)) = (e["path"].as_str(), e["sha"].as_str()) {
                    remote.insert(p.to_string(), s.to_string());
                }
            }
        }
        let mut changed = Vec::new();
        for (path, sha) in &remote {
            let Some(local) = safe_path(path) else { continue };
            if index.files.get(path) == Some(sha) && local.exists() {
                continue;
            }
            let r = self.call("GET", &self.url(&format!("/contents/{path}?ref={head}")), "application/vnd.github.raw+json", None, None)?;
            if r.status != 200 {
                bail!("download {path}: HTTP {}", r.status);
            }
            if let Some(dir) = local.parent() {
                fs::create_dir_all(dir)?;
            }
            let tmp = local.with_extension("part");
            fs::write(&tmp, &r.body)?;
            fs::rename(&tmp, &local)?;
            index.files.insert(path.clone(), sha.clone());
            changed.push(path.clone());
            log(&format!("synced {path} ({} bytes)", r.body.len()));
        }
        for path in index.files.keys().cloned().collect::<Vec<_>>() {
            if !remote.contains_key(&path) {
                if let Some(local) = safe_path(&path) {
                    let _ = fs::remove_file(local);
                }
                index.files.remove(&path);
                changed.push(path);
            }
        }
        index.head = head;
        index.save()?;
        Ok(changed)
    }

    /// Commits one file's current content on the branch. A conflict (someone changed the file
    /// meanwhile) pulls, puts the local content back and tries once more.
    pub fn put(&self, path: &str, message: &str) -> Result<()> {
        let local = safe_path(path).context("bad path")?;
        let content = fs::read(&local)?;
        match self.put_once(path, &content, message)? {
            true => Ok(()),
            false => {
                log(&format!("repo: {path} changed remotely; pulling and writing again"));
                self.pull()?;
                if let Some(dir) = local.parent() {
                    fs::create_dir_all(dir)?;
                }
                fs::write(&local, &content)?;
                if self.put_once(path, &content, message)? { Ok(()) } else { bail!("{path}: still conflicting after a pull") }
            }
        }
    }

    fn put_once(&self, path: &str, content: &[u8], message: &str) -> Result<bool> {
        let mut index = Index::load();
        let mut body = json!({
            "message": message,
            "content": base64::engine::general_purpose::STANDARD.encode(content),
            "branch": self.branch,
        });
        if let Some(sha) = index.files.get(path) {
            body["sha"] = json!(sha);
        }
        let (status, _, v) = self.json("PUT", &format!("/contents/{path}"), None, Some(&body))?;
        match status {
            200 | 201 => {
                if let Some(sha) = v["content"]["sha"].as_str() {
                    index.files.insert(path.to_string(), sha.to_string());
                }
                if let Some(head) = v["commit"]["sha"].as_str() {
                    index.head = head.to_string();
                }
                index.etag.clear();
                index.save()?;
                Ok(true)
            }
            409 | 422 => Ok(false),
            _ => bail!("{}", Self::fail(status, &v, &format!("put {path}"))),
        }
    }

    pub fn ready(&self) -> bool {
        Path::new(REPO_PARENT).exists()
    }
}
