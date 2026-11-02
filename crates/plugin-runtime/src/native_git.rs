//! Verify remote bundles in a disposable object database before publishing a local ref.
use crate::{
    BrokerError, BundleTicket,
    native_command::{self, denied},
    native_process::Image,
};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

#[derive(Clone)]
pub struct NativeGit {
    context: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    image: Image,
    repo: Image,
    home: PathBuf,
    env: HashMap<String, String>,
}
/// Keeps cancellation from stranding an inspection database. Cleanup checks the
/// created directory identity before traversing; a replacement is never ours.
struct InspectionDirectory {
    path: PathBuf,
    identity: fs::Metadata,
    removed: bool,
}
impl InspectionDirectory {
    fn remove(&mut self) -> Result<(), BrokerError> {
        let current = fs::symlink_metadata(&self.path).map_err(|_| denied())?;
        if !current.is_dir()
            || current.dev() != self.identity.dev()
            || current.ino() != self.identity.ino()
        {
            return Err(denied());
        }
        fs::remove_dir_all(&self.path)
            .map_err(|_| BrokerError::Effect("bundle inspection cleanup unverified".into()))?;
        self.removed = true;
        Ok(())
    }
}
impl Drop for InspectionDirectory {
    fn drop(&mut self) {
        if !self.removed {
            let _ = self.remove();
        }
    }
}
pub struct VerifiedBundle {
    bytes: Vec<u8>,
    head: String,
    commits: u64,
    branch: String,
    base: String,
}
impl VerifiedBundle {
    pub fn head(&self) -> &str {
        &self.head
    }
    pub fn commits(&self) -> u64 {
        self.commits
    }
}
impl Drop for VerifiedBundle {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}
pub fn facts(text: &str) -> Result<HashMap<String, String>, BrokerError> {
    let text =
        text.trim_end_matches(|c: char| crate::js_semantics::trim(&c.to_string()).is_empty());
    let mut facts = HashMap::new();
    for line in text.split('\n') {
        let (k, v) = line
            .split_once('=')
            .filter(|(k, _)| !k.is_empty())
            .ok_or_else(denied)?;
        if facts.insert(k.into(), v.into()).is_some() {
            return Err(denied());
        }
    }
    Ok(facts)
}
pub fn remote_preflight(text: &str, base: &str) -> Result<(String, u64), BrokerError> {
    let f = facts(text)?;
    let head = f.get("head").ok_or_else(denied)?;
    let n = f.get("commits").ok_or_else(denied)?;
    if f.get("ancestor").map(String::as_str) != Some("1")
        || f.get("dirty").map(String::as_str) != Some("0")
        || head.len() != base.len()
        || !head
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || n.starts_with('0')
        || !n.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(denied());
    }
    let count = n
        .parse::<u64>()
        .ok()
        .filter(|n| (1..=500).contains(n))
        .ok_or_else(denied)?;
    Ok((head.clone(), count))
}
impl NativeGit {
    pub fn with_context(mut self, context: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.context = Some(context);
        self
    }
    fn check_context(&self) -> Result<(), BrokerError> {
        if self.context.as_ref().is_some_and(|check| !check()) {
            return Err(denied());
        }
        Ok(())
    }

    /// Journal the exact local destination before provider preflight/fetch. A
    /// lost transfer reply must reuse this destination, never pick a new branch.
    pub async fn admit_destination(
        &self,
        home: &Path,
        id: &str,
        run: &Value,
        deadline: Instant,
    ) -> Result<(), BrokerError> {
        let mut store = TaskStore::open(home)?;
        let task = transfer_owner(&mut store, id, run)?;
        let primary = format!("pacer/{id}");
        let attempt = crate::js_semantics::safe_u64(&run["attempt"]).ok_or_else(denied)?;
        let alternate = format!("{primary}-r{attempt}");
        if let Some(prior) = task.get("remoteTransferIntent") {
            for key in ["attempt", "dir", "startedAt"] {
                if !crate::js_semantics::json_equal(&prior[key], &run[key]) {
                    return Err(denied());
                }
            }
            if prior["providerId"] != "pacer-exec-direct"
                || ![primary, alternate].iter().any(|b| prior["branch"] == *b)
                || prior["oldHead"]
                    .as_str()
                    .is_none_or(|s| !s.is_empty() && !valid_sha(s))
            {
                return Err(denied());
            }
            return Ok(());
        }
        let repo = self.repo()?;
        let mut branch = primary;
        let mut current = String::new();
        let reference = format!("refs/heads/{branch}");
        let result = self
            .command(
                &["-C", repo, "show-ref", "--verify", "--quiet", &reference].map(str::to_owned),
                &[],
                1024 * 1024,
                deadline,
            )
            .await?;
        match result.code {
            0 => {
                current = self
                    .text(repo, &["rev-parse", "--verify", &reference], &[], deadline)
                    .await?;
                let ahead = self
                    .text(
                        repo,
                        &[
                            "rev-list",
                            "--count",
                            &format!("{}..{current}", run["baseSha"].as_str().ok_or_else(denied)?),
                        ],
                        &[],
                        deadline,
                    )
                    .await?;
                if ahead != "0" {
                    branch = alternate;
                    current.clear();
                }
            }
            1 => {}
            _ => return Err(denied()),
        }
        let latest = transfer_owner(&mut store, id, run)?;
        if latest["rev"] != task["rev"] {
            return Err(denied());
        }
        store.update(id,crate::native_run::rev(&latest)?,crate::native_run::now(),|t| {
            t["remoteTransferIntent"] = json!({"attempt":run["attempt"],"providerId":"pacer-exec-direct","dir":run["dir"],"startedAt":run["startedAt"],"branch":branch,"oldHead":current});
        })?;
        Ok(())
    }
    pub fn prepare(
        home: &Path,
        repo: &Path,
        executable: &str,
        env: &HashMap<String, String>,
    ) -> Result<Self, BrokerError> {
        let mut private = HashMap::from([
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ]);
        for k in ["HOME", "PATH"] {
            if let Some(v) = env.get(k) {
                private.insert(k.into(), v.clone());
            }
        }
        Ok(Self {
            context: None,
            image: Image::pin(executable, true)?,
            repo: Image::pin(repo.to_str().ok_or_else(denied)?, false)?,
            home: home.into(),
            env: private,
        })
    }
    pub async fn command(
        &self,
        args: &[String],
        input: &[u8],
        max: usize,
        deadline: Instant,
    ) -> Result<native_command::Output, BrokerError> {
        self.check_context()?;
        self.repo.check()?;
        let result =
            native_command::run(&self.image, args, &self.env, input, 60000, max, deadline).await?;
        self.repo.check()?;
        self.check_context()?;
        if result.timed_out {
            return Err(BrokerError::Timeout);
        }
        Ok(result)
    }
    pub async fn text(
        &self,
        repo: &str,
        args: &[&str],
        input: &[u8],
        deadline: Instant,
    ) -> Result<String, BrokerError> {
        let argv = ["-C", repo]
            .into_iter()
            .chain(args.iter().copied())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let out = self.command(&argv, input, 1024 * 1024, deadline).await?;
        if out.code != 0 {
            return Err(BrokerError::Effect(
                "Git verification or publication failed".into(),
            ));
        }
        Ok(crate::js_semantics::trim(&String::from_utf8_lossy(&out.stdout)).into())
    }
    pub fn repo(&self) -> Result<&str, BrokerError> {
        self.repo.canonical.to_str().ok_or_else(denied)
    }
    pub async fn base_bundle(
        &self,
        id: &str,
        base: &str,
        deadline: Instant,
    ) -> Result<Vec<u8>, BrokerError> {
        if !pacer_store::is_task_id(id) || !valid_sha(base) {
            return Err(denied());
        }
        // The bounded job owns both ref creation and cleanup. Dropping the
        // caller's future must not cancel the finally step after update-ref.
        let owner = self.clone();
        let id = id.to_owned();
        let base = base.to_owned();
        tokio::spawn(async move { owner.base_bundle_owned(&id, &base, deadline).await })
            .await
            .map_err(|_| denied())?
    }
    async fn base_bundle_owned(
        &self,
        id: &str,
        base: &str,
        deadline: Instant,
    ) -> Result<Vec<u8>, BrokerError> {
        let repo = self.repo()?;
        let reference = format!("refs/pacer/base/{id}");
        let create = self
            .text(repo, &["update-ref", &reference, base], &[], deadline)
            .await;
        let args = ["-C", repo, "bundle", "create", "-", &reference].map(str::to_owned);
        let result = match create {
            Ok(_) => self.command(&args, &[], 50 * 1024 * 1024, deadline).await,
            Err(e) => Err(e),
        };
        // Cleanup gets a bounded independent budget even when the owner expired.
        self.repo.check()?;
        let cleanup = native_command::run(
            &self.image,
            &["-C", repo, "update-ref", "-d", &reference].map(str::to_owned),
            &self.env,
            &[],
            10000,
            1024 * 1024,
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .await?;
        if cleanup.code != 0 || cleanup.timed_out {
            return Err(BrokerError::Effect(
                "base bundle ref cleanup unverified".into(),
            ));
        }
        let out = result?;
        if out.code != 0 {
            return Err(denied());
        }
        Ok(out.stdout)
    }
    pub async fn verify(
        &self,
        ticket: &mut BundleTicket,
        base: &str,
        branch: &str,
        deadline: Instant,
    ) -> Result<VerifiedBundle, BrokerError> {
        if ticket.bytes() == 0
            || ticket.bytes() > 50 * 1024 * 1024
            || !valid_sha(base)
            || !valid_branch(branch)
        {
            return Err(denied());
        }
        let bytes = ticket.read()?;
        let repo = self.repo()?;
        let email = self
            .text(repo, &["config", "user.email"], &[], deadline)
            .await?;
        if email.is_empty() || email.contains(['\r', '\n', '\0']) {
            return Err(denied());
        }
        if self
            .text(
                repo,
                &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
                &[],
                deadline,
            )
            .await?
            != base
        {
            return Err(denied());
        }
        let format = self
            .text(repo, &["rev-parse", "--show-object-format"], &[], deadline)
            .await?;
        if !matches!((format.as_str(), base.len()), ("sha1", 40) | ("sha256", 64)) {
            return Err(denied());
        }
        self.text(repo, &["bundle", "verify", "/dev/fd/0"], &bytes, deadline)
            .await?;
        let listed = self
            .text(
                repo,
                &["bundle", "list-heads", "/dev/fd/0"],
                &bytes,
                deadline,
            )
            .await?;
        let suffix = format!(" refs/heads/{branch}");
        let head = listed
            .strip_suffix(&suffix)
            .filter(|h| valid_sha(h))
            .ok_or_else(denied)?
            .to_owned();
        let objects = self
            .text(
                repo,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-path",
                    "objects",
                ],
                &[],
                deadline,
            )
            .await?;
        if !Path::new(&objects).is_absolute() {
            return Err(denied());
        }
        let root = self.home.join("transfers");
        let identity = fs::symlink_metadata(&root).map_err(|_| denied())?;
        if !identity.is_dir() || identity.mode() & 0o077 != 0 {
            return Err(denied());
        }
        let inspection = root.join(format!(".bundle-inspect-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&inspection)
            .map_err(|_| denied())?;
        let mut cleanup = InspectionDirectory {
            identity: fs::symlink_metadata(&inspection).map_err(|_| denied())?,
            path: inspection.clone(),
            removed: false,
        };
        let inspected = inspection.to_str().ok_or_else(denied)?;
        let result = async {
            self.text(
                inspected,
                &["init", "--bare", "-q", &format!("--object-format={format}")],
                &[],
                deadline,
            )
            .await?;
            let mut env = self.env.clone();
            env.insert("GIT_ALTERNATE_OBJECT_DIRECTORIES".into(), objects);
            let run = async |args: Vec<String>, input: &[u8]| -> Result<String, BrokerError> {
                self.check_context()?;
                self.repo.check()?;
                let argv = ["-C".into(), inspected.into()]
                    .into_iter()
                    .chain(args)
                    .collect::<Vec<_>>();
                let out = native_command::run(
                    &self.image,
                    &argv,
                    &env,
                    input,
                    10000,
                    1024 * 1024,
                    deadline,
                )
                .await?;
                self.repo.check()?;
                self.check_context()?;
                if out.timed_out {
                    return Err(BrokerError::Timeout);
                }
                if out.code != 0 {
                    return Err(denied());
                }
                Ok(crate::js_semantics::trim(&String::from_utf8_lossy(&out.stdout)).into())
            };
            let args = |s: &[&str]| s.iter().map(|s| (*s).into()).collect::<Vec<String>>();
            if run(args(&["bundle", "unbundle", "/dev/fd/0"]), &bytes).await?
                != format!("{head}{suffix}")
                || run(
                    args(&["rev-parse", "--verify", &format!("{head}^{{commit}}")]),
                    &[],
                )
                .await?
                    != head
            {
                return Err(denied());
            }
            run(args(&["merge-base", "--is-ancestor", base, &head]), &[]).await?;
            let range = format!("{base}..{head}");
            let count = run(args(&["rev-list", "--count", &range]), &[]).await?;
            let commits = count
                .parse::<u64>()
                .ok()
                .filter(|n| (1..=500).contains(n))
                .ok_or_else(denied)?;
            let log = run(
                args(&["log", "--format=%ae%x00%ce%x00%B%x00%x00", &range]),
                &[],
            )
            .await?;
            let records = log
                .split("\0\0")
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            if records.len() != commits as usize {
                return Err(denied());
            }
            let signoff = regex::Regex::new(r"(?:^|[\n\r\u{2028}\u{2029}])(?i-u:Signed-off-by:)[^\n\r\u{2028}\u{2029}]*<([^>]+)>").map_err(|_| denied())?;
            for record in records {
                let mut parts = record.trim_start_matches('\n').splitn(3, '\0');
                if parts.next() != Some(email.as_str()) || parts.next() != Some(email.as_str()) {
                    return Err(denied());
                }
                if signoff.captures_iter(parts.next().unwrap_or_default()).any(|capture| capture[1] != email) {
                    return Err(denied());
                }
            }
            // The stage remains pinned through inspection; never import reopened writable bytes.
            if ticket.read()? != bytes {
                return Err(denied());
            }
            Ok(VerifiedBundle {
                bytes,
                head,
                commits,
                branch: branch.into(),
                base: base.into(),
            })
        }
        .await;
        cleanup.remove()?;
        result
    }
    pub async fn publish(
        &self,
        home: &Path,
        id: &str,
        run: &Value,
        verified: VerifiedBundle,
        deadline: Instant,
    ) -> Result<Value, BrokerError> {
        let mut store = TaskStore::open(home)?;
        let mut task = transfer_owner(&mut store, id, run)?;
        let repo = self.repo()?;
        let primary = format!("pacer/{id}");
        let attempt = crate::js_semantics::safe_u64(&run["attempt"]).ok_or_else(denied)?;
        let alternate = format!("{primary}-r{attempt}");
        let prior = task.get("remoteTransferIntent").cloned();
        let mut branch = prior
            .as_ref()
            .and_then(|p| p["branch"].as_str())
            .unwrap_or(&primary)
            .to_owned();
        if branch != primary && branch != alternate {
            return Err(denied());
        }
        let mut reference = format!("refs/heads/{branch}");
        let mut current = String::new();
        let query = ["-C", repo, "show-ref", "--verify", "--quiet", &reference].map(str::to_owned);
        let exists = self.command(&query, &[], 1024 * 1024, deadline).await?;
        if exists.code != 0 && exists.code != 1 {
            return Err(denied());
        }
        if exists.code == 0 {
            current = self
                .text(repo, &["rev-parse", "--verify", &reference], &[], deadline)
                .await?;
            let ahead = self
                .text(
                    repo,
                    &[
                        "rev-list",
                        "--count",
                        &format!("{}..{current}", verified.base),
                    ],
                    &[],
                    deadline,
                )
                .await?;
            if prior.is_none() && ahead != "0" {
                branch = alternate;
                reference = format!("refs/heads/{branch}");
                current.clear();
            }
        }
        let destination = json!({"attempt":run["attempt"],"providerId":"pacer-exec-direct","dir":run["dir"],"startedAt":run["startedAt"],"branch":branch,"oldHead":current});
        if let Some(prior) = prior {
            for key in ["attempt", "providerId", "dir", "startedAt", "branch"] {
                if !crate::js_semantics::json_equal(&prior[key], &destination[key]) {
                    return Err(denied());
                }
            }
            let old = prior["oldHead"].as_str().ok_or_else(denied)?;
            if (!old.is_empty() && !valid_sha(old)) || (current != old && current != verified.head)
            {
                return Err(denied());
            }
        } else {
            task = store.update(
                id,
                crate::native_run::rev(&task)?,
                crate::native_run::now(),
                |t| t["remoteTransferIntent"] = destination,
            )?;
        }
        let rev = task["rev"].clone();
        let imported = self
            .text(
                repo,
                &["bundle", "unbundle", "/dev/fd/0"],
                &verified.bytes,
                deadline,
            )
            .await?;
        if imported != format!("{} refs/heads/{}", verified.head, verified.branch) {
            return Err(denied());
        }
        let top = self
            .text(repo, &["rev-parse", "--show-toplevel"], &[], deadline)
            .await?;
        let top = fs::canonicalize(top).map_err(|_| denied())?;
        let name =
            crate::js_semantics::path_tag(&top.file_name().ok_or_else(denied)?.to_string_lossy());
        let tag = format!(
            "{name}-{}",
            &format!("{:x}", Sha1::digest(top.as_os_str().as_encoded_bytes()))[..8]
        );
        let work = home.join("worktrees").join(tag).join(id);
        let work_text = work.to_str().ok_or_else(denied)?;
        let reuse = work.exists();
        let mut switch = false;
        if reuse {
            let checked = self
                .text(work_text, &["symbolic-ref", "HEAD"], &[], deadline)
                .await?;
            if checked != reference && checked != format!("refs/heads/{primary}") {
                return Err(denied());
            }
            if !self
                .text(work_text, &["status", "--porcelain"], &[], deadline)
                .await?
                .is_empty()
            {
                return Err(denied());
            }
            switch = checked != reference;
        }
        let current_task = transfer_owner(&mut store, id, run)?;
        if current_task["rev"] != rev {
            return Err(denied());
        }
        let old = if current.is_empty() {
            "0".repeat(verified.head.len())
        } else {
            current
        };
        self.text(
            repo,
            &["update-ref", &reference, &verified.head, &old],
            &[],
            deadline,
        )
        .await?;
        if reuse {
            if switch {
                self.text(work_text, &["checkout", "-q", &branch], &[], deadline)
                    .await?;
            } else {
                self.text(
                    work_text,
                    &["read-tree", "--reset", "-u", &verified.head],
                    &[],
                    deadline,
                )
                .await?;
            }
        } else {
            self.text(
                repo,
                &["worktree", "add", "-q", work_text, &branch],
                &[],
                deadline,
            )
            .await?;
        }
        let current = transfer_owner(&mut store, id, run)?;
        store.update(
            id,
            crate::native_run::rev(&current)?,
            crate::native_run::now(),
            |t| t["run"]["transferredHead"] = json!(verified.head),
        )?;
        Ok(
            json!({"transferred":true,"branch":branch,"commits":verified.commits,"reviewWorktree":work}),
        )
    }
}
fn valid_sha(s: &str) -> bool {
    (40..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_branch(s: &str) -> bool {
    s.starts_with("pacer/")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
}
pub fn transfer_owner(store: &mut TaskStore, id: &str, run: &Value) -> Result<Value, BrokerError> {
    let task = store.read(id)?.ok_or_else(denied)?;
    if task["state"] != "running"
        || task.get("stopPending").is_some()
        || task["executorProvider"] != "pacer-exec-direct"
    {
        return Err(denied());
    }
    for key in [
        "dir",
        "attempt",
        "executor",
        "startedAt",
        "workdir",
        "host",
        "remoteDir",
        "remoteWorktree",
        "remoteBranch",
        "baseSha",
    ] {
        if !crate::js_semantics::json_equal(&task["run"][key], &run[key]) {
            return Err(denied());
        }
    }
    for kind in ["startIntent", "executorExitReceipt"] {
        let r = &task[kind];
        if !crate::js_semantics::json_equal(&r["attempt"], &run["attempt"])
            || r["providerId"] != "pacer-exec-direct"
            || r["dir"] != run["dir"]
        {
            return Err(denied());
        }
    }
    if !crate::js_semantics::json_equal(
        &task["executorExitReceipt"]["startedAt"],
        &run["startedAt"],
    ) {
        return Err(denied());
    }
    Ok(task)
}
