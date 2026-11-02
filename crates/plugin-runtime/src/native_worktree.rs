//! Native, journaled Git placement for the one running provider-owned task.
use crate::{
    AuthorityError, BrokerError, CommandResource, NativeProcess, NativeWrite, WriteResource,
};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
fn denied() -> BrokerError {
    AuthorityError::Denied("worktree owner or repository identity changed".into()).into()
}
fn store_error(_: pacer_store::StoreError) -> BrokerError {
    denied()
}
struct Pin {
    logical: PathBuf,
    canonical: PathBuf,
    link: Metadata,
    target: Metadata,
}
impl Pin {
    fn new(path: &Path) -> Result<Self, BrokerError> {
        let canonical = fs::canonicalize(path).map_err(|_| denied())?;
        let link = fs::symlink_metadata(path).map_err(|_| denied())?;
        let target = fs::metadata(&canonical).map_err(|_| denied())?;
        Ok(Self {
            logical: path.into(),
            canonical,
            link,
            target,
        })
    }
    fn check(&self) -> Result<(), BrokerError> {
        let same = |a: &Metadata, b: &Metadata| a.dev() == b.dev() && a.ino() == b.ino();
        if fs::canonicalize(&self.logical).ok().as_ref() != Some(&self.canonical)
            || !fs::symlink_metadata(&self.logical).is_ok_and(|m| same(&m, &self.link))
            || !fs::metadata(&self.canonical).is_ok_and(|m| same(&m, &self.target))
        {
            return Err(denied());
        }
        Ok(())
    }
}
pub struct NativeWorktree {
    store: TaskStore,
    home: PathBuf,
    task_id: String,
    provider_id: String,
    attempt: u64,
    rev: u64,
    source: String,
    top: String,
    main: String,
    common: String,
    sub: String,
    dirty: bool,
    busy: bool,
    base_repo: String,
    base: String,
    sha: String,
    path: String,
    workdir: String,
    branch: String,
    reused_workdir: Option<String>,
    pins: Vec<Pin>,
    git: String,
    git_image: Metadata,
    env: HashMap<String, String>,
    used: bool,
}
impl NativeWorktree {
    pub async fn issue(
        home: &Path,
        task_id: &str,
        provider_id: &str,
        attempt: u64,
        base: &str,
        git: &str,
        env: HashMap<String, String>,
    ) -> Result<Self, BrokerError> {
        if base.is_empty()
            || crate::js_semantics::utf16_len(base) > 256
            || base.starts_with('-')
            || attempt == 0
            || attempt > 9_007_199_254_740_991
        {
            return Err(BrokerError::Invalid("worktree base or attempt"));
        }
        let mut store = TaskStore::open(home).map_err(store_error)?;
        let task = store
            .read(task_id)
            .map_err(store_error)?
            .ok_or_else(denied)?;
        check_task(&task, provider_id, attempt)?;
        let source = task
            .pointer("/brief/repo")
            .and_then(Value::as_str)
            .filter(|s| Path::new(s).is_absolute())
            .ok_or_else(denied)?
            .to_owned();
        let top = git_text(git, &env, &source, &["rev-parse", "--show-toplevel"]).await?;
        let common = git_text(
            git,
            &env,
            &source,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        let common = fs::canonicalize(common)
            .map_err(|_| denied())?
            .to_string_lossy()
            .into_owned();
        let main = Path::new(&common)
            .parent()
            .ok_or_else(denied)?
            .to_string_lossy()
            .into_owned();
        let real_source = fs::canonicalize(&source).map_err(|_| denied())?;
        let real_top = fs::canonicalize(&top).map_err(|_| denied())?;
        let sub = real_source
            .strip_prefix(&real_top)
            .map_err(|_| denied())?
            .to_string_lossy()
            .into_owned();
        let tag_name = crate::js_semantics::path_tag(
            &real_top.file_name().ok_or_else(denied)?.to_string_lossy(),
        );
        let digest = format!("{:x}", Sha1::digest(real_top.to_string_lossy().as_bytes()));
        let mut path = home
            .join("worktrees")
            .join(format!("{tag_name}-{}", &digest[..8]))
            .join(task_id)
            .to_string_lossy()
            .into_owned();
        let mut workdir = Path::new(&path).join(&sub).to_string_lossy().into_owned();
        let mut branch = format!("pacer/{task_id}");
        let mut selected = base.to_owned();
        let mut base_repo = top.clone();
        let reused_workdir = task
            .get("worktree")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(reused) = &reused_workdir {
            let owner = task
                .get("retryOf")
                .and_then(Value::as_str)
                .unwrap_or(task_id);
            if owner == task_id && task["attempts"].as_array().is_none_or(|a| a.is_empty()) {
                return Err(denied());
            }
            if owner != task_id {
                let prior = store.read(owner).map_err(store_error)?.ok_or_else(denied)?;
                if ![
                    "done",
                    "partial",
                    "failed",
                    "limit",
                    "stopped",
                    "needs_input",
                ]
                .contains(&prior["state"].as_str().unwrap_or_default())
                    || (prior.get("worktree").and_then(Value::as_str) != Some(reused)
                        && prior.pointer("/result/worktree").and_then(Value::as_str)
                            != Some(reused))
                {
                    return Err(denied());
                }
            }
            let expected = home
                .join("worktrees")
                .join(format!("{tag_name}-{}", &digest[..8]))
                .join(owner);
            let reused_top = git_text(git, &env, reused, &["rev-parse", "--show-toplevel"]).await?;
            if fs::canonicalize(&reused_top).ok() != fs::canonicalize(expected).ok() {
                return Err(denied());
            }
            path = reused_top;
            workdir = reused.clone();
            branch = format!("pacer/{owner}");
            selected = "HEAD".into();
            base_repo = path.clone();
            if git_text(
                git,
                &env,
                &path,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
            )
            .await?
                != branch
                || fs::canonicalize(
                    git_text(
                        git,
                        &env,
                        &path,
                        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                    )
                    .await?,
                )
                .ok()
                    != Some(PathBuf::from(&common))
            {
                return Err(denied());
            }
        }
        let sha = git_text(
            git,
            &env,
            &base_repo,
            &["rev-parse", "--verify", &format!("{selected}^{{commit}}")],
        )
        .await?;
        if !valid_sha(&sha) {
            return Err(denied());
        }
        let dirty = !git_text(git, &env, &source, &["status", "--porcelain"])
            .await?
            .is_empty();
        let busy = store
            .list(&pacer_store::TaskFilter {
                states: Some(&["running"]),
                ..Default::default()
            })
            .map_err(store_error)?
            .iter()
            .any(|other| {
                other["id"] != task_id
                    && other
                        .get("worktree")
                        .or_else(|| other.pointer("/brief/repo"))
                        .and_then(Value::as_str)
                        .is_some_and(|p| fs::canonicalize(p).ok() == Some(real_source.clone()))
            });
        let pins = [
            home.to_path_buf(),
            PathBuf::from(&source),
            PathBuf::from(&top),
            PathBuf::from(&main),
            PathBuf::from(&common),
        ]
        .iter()
        .map(|p| Pin::new(p))
        .collect::<Result<Vec<_>, _>>()?;
        let git_image = fs::metadata(git).map_err(|_| denied())?;
        let mut native = Self {
            store,
            home: home.into(),
            task_id: task_id.into(),
            provider_id: provider_id.into(),
            attempt,
            rev: task
                .get("rev")
                .and_then(crate::js_semantics::safe_u64)
                .ok_or_else(denied)?,
            source,
            top,
            main,
            common,
            sub,
            dirty,
            busy,
            base_repo,
            base: selected,
            sha,
            path,
            workdir,
            branch,
            reused_workdir,
            pins,
            git: git.into(),
            git_image,
            env,
            used: false,
        };
        native.owner(false)?;
        Ok(native)
    }
    fn intent(&self) -> Value {
        json!({"attempt":self.attempt,"providerId":self.provider_id,"repoTop":self.top,"repoMain":self.main,"path":self.path,"workdir":self.workdir,"branch":self.branch,"baseSha":self.sha})
    }
    fn owner(&mut self, after_intent: bool) -> Result<Value, BrokerError> {
        for pin in &self.pins {
            pin.check()?;
        }
        let image = fs::metadata(&self.git).map_err(|_| denied())?;
        if image.dev() != self.git_image.dev()
            || image.ino() != self.git_image.ino()
            || image.len() != self.git_image.len()
            || image.mtime() != self.git_image.mtime()
            || image.mtime_nsec() != self.git_image.mtime_nsec()
            || image.mode() != self.git_image.mode()
        {
            return Err(denied());
        }
        let task = self
            .store
            .read(&self.task_id)
            .map_err(store_error)?
            .ok_or_else(denied)?;
        check_task(&task, &self.provider_id, self.attempt)?;
        if task.pointer("/brief/repo").and_then(Value::as_str) != Some(&self.source)
            || self
                .reused_workdir
                .as_ref()
                .is_some_and(|p| task["worktree"] != *p)
            || (!after_intent
                && task.get("rev").and_then(crate::js_semantics::safe_u64) != Some(self.rev))
        {
            return Err(denied());
        }
        if let Some(intent) = task.get("worktreeIntent") {
            if intent != &self.intent() {
                return Err(denied());
            }
        } else if after_intent {
            return Err(denied());
        }
        Ok(task)
    }
    pub async fn answer(
        &mut self,
        method: &str,
        params: &Value,
        deadline: Instant,
    ) -> Result<Value, BrokerError> {
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        if params["taskId"] != self.task_id
            || params
                .get("attempt")
                .and_then(crate::js_semantics::safe_u64)
                != Some(self.attempt)
        {
            return Err(denied());
        }
        let task = self.owner(false)?;
        if method == "capability.worktree.inspect" {
            return Ok(
                json!({"top":self.top,"main":self.main,"sub":if self.sub.is_empty(){Value::Null}else{json!(self.sub)},"dirty":self.dirty,"busy":self.busy,"existingWorkdir":task.get("worktree").cloned().unwrap_or(Value::Null)}),
            );
        }
        let exact = git_text(
            &self.git,
            &self.env,
            &self.base_repo,
            &[
                "rev-parse",
                "--verify",
                &format!("{}^{{commit}}", self.base),
            ],
        )
        .await?;
        if exact != self.sha {
            return Err(denied());
        }
        self.owner(false)?;
        if method == "capability.worktree.resolveBase" {
            return Ok(json!({"base":self.base,"sha":self.sha}));
        }
        if method != "capability.worktree.createOrReuse"
            || self.used
            || params["baseSha"] != self.sha
        {
            return Err(denied());
        }
        self.used = true;
        if task.get("worktreeIntent").is_none() {
            let intent = self.intent();
            self.store
                .update(
                    &self.task_id,
                    self.rev as i64,
                    pacer_foundation::ctx::unix_now(),
                    |task| task["worktreeIntent"] = intent,
                )
                .map_err(store_error)?;
        }
        self.owner(true)?;
        let root = self.home.join("worktrees");
        let parent = Path::new(&self.path)
            .parent()
            .ok_or_else(denied)?
            .to_path_buf();
        let descriptors = [
            WriteResource {
                path: root.to_string_lossy().into_owned(),
                kind: "directory".into(),
                operations: vec!["mkdir".into()],
            },
            WriteResource {
                path: parent.to_string_lossy().into_owned(),
                kind: "directory".into(),
                operations: vec!["mkdir".into()],
            },
        ];
        let mut writes = NativeWrite::prepare(&self.home, &descriptors)?;
        for path in [&root, &parent] {
            writes.answer("capability.fs.mkdir", &json!({"path":path}))?;
        }
        let reused = Path::new(&self.path).exists();
        if !reused {
            let check = git_result(
                &self.git,
                &self.env,
                &self.top,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", self.branch),
                ],
            )
            .await?;
            if check["code"].as_f64() != Some(1.0) || check["timedOut"] != false {
                return Err(denied());
            }
            self.owner(true)?;
            git_text(
                &self.git,
                &self.env,
                &self.top,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    &self.branch,
                    &self.path,
                    &self.sha,
                ],
            )
            .await?;
        }
        self.owner(true)?;
        if fs::symlink_metadata(&self.path).is_err()
            || fs::symlink_metadata(&self.path).is_ok_and(|m| m.file_type().is_symlink())
            || fs::canonicalize(&self.path).ok()
                != Some(
                    fs::canonicalize(&parent)
                        .map_err(|_| denied())?
                        .join(Path::new(&self.path).file_name().ok_or_else(denied)?),
                )
        {
            return Err(denied());
        }
        let common = git_text(
            &self.git,
            &self.env,
            &self.path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        if fs::canonicalize(common).ok() != Some(PathBuf::from(&self.common))
            || git_text(
                &self.git,
                &self.env,
                &self.path,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
            )
            .await?
                != self.branch
            || git_text(
                &self.git,
                &self.env,
                &self.path,
                &["rev-parse", "--verify", "HEAD^{commit}"],
            )
            .await?
                != self.sha
        {
            return Err(denied());
        }
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        Ok(
            json!({"path":self.path,"workdir":self.workdir,"branch":self.branch,"baseSha":self.sha,"reused":reused}),
        )
    }
}
fn check_task(task: &Value, provider: &str, attempt: u64) -> Result<(), BrokerError> {
    if task["state"] != "running"
        || task
            .get("stopPending")
            .is_some_and(|v| !v.is_null() && *v != false)
        || task["executorProvider"] != provider
        || task["attempts"]
            .as_array()
            .is_none_or(|a| a.len() as u64 + 1 != attempt)
    {
        return Err(denied());
    }
    Ok(())
}
async fn git_result(
    git: &str,
    env: &HashMap<String, String>,
    repo: &str,
    args: &[&str],
) -> Result<Value, BrokerError> {
    let argv: Vec<String> = ["git", "-C", repo]
        .into_iter()
        .chain(args.iter().copied())
        .map(str::to_owned)
        .collect();
    let resource = CommandResource {
        argv: argv.clone(),
        timeout_ms: 60_000,
        stdin: None,
        cwd: None,
        env: Some(env.clone()),
        ..Default::default()
    };
    NativeProcess::prepare(
        &[resource],
        &HashMap::from([("git".into(), git.into())]),
        env,
    )?
    .spawn(
        &json!({"argv":argv,"timeoutMs":60_000,"env":env}),
        Instant::now() + Duration::from_secs(60),
    )
    .await
}
async fn git_text(
    git: &str,
    env: &HashMap<String, String>,
    repo: &str,
    args: &[&str],
) -> Result<String, BrokerError> {
    let result = git_result(git, env, repo, args).await?;
    if result["code"].as_f64() != Some(0.0) || result["timedOut"] != false {
        return Err(denied());
    }
    Ok(crate::js_semantics::trim(result["stdout"].as_str().ok_or_else(denied)?).into())
}
fn valid_sha(value: &str) -> bool {
    [40, 64].contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
