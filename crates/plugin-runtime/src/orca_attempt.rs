//! Concrete host-owned Orca attempt. Placement and launch policy are issued by the
//! host; a provider sequences only the phase-checked task/attempt operations.
mod account_folders;
pub(crate) mod client;
mod evidence;
pub(crate) mod journal;
mod lane;
pub(crate) mod runner;
pub use runner::OrcaStrategySource;
pub mod launch;
mod supervision;
mod wire;
use crate::{BrokerError, WireReply, native_command::denied};
use client::OrcaClient;
use journal::Journal;
use pacer_store::{TaskEdit, TaskStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};
// Match TaskStore::read's legacy revision default without rebuilding its text.
fn task_snapshot(
    store: &mut TaskStore,
    id: &str,
) -> Result<Option<WireReply>, pacer_store::StoreError> {
    let Some(mut wire) = store.read_wire(id)? else {
        return Ok(None);
    };
    if wire.preview().get("rev").is_none_or(Value::is_null) {
        wire.put("/rev", WireReply::new(json!(1)))?;
    }
    Ok(Some(wire))
}
#[derive(Clone)]
pub enum OrcaPlacement {
    Existing {
        path: String,
    },
    NewChild {
        repo_id: String,
        name: String,
        base_sha: String,
        parent: Option<String>,
    },
}
#[derive(Clone)]
pub struct OrcaAttemptSpec {
    pub executor: String,
    pub agent: String,
    pub model: Option<String>,
    pub coordinator: String,
    pub run: String,
    pub top: String,
    pub base: String,
    pub sub: String,
    pub placement: OrcaPlacement,
    pub notes: Vec<String>,
    pub prompt: String,
    pub launch: Vec<String>,
    pub account_env: HashMap<String, String>,
}
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
enum Phase {
    New,
    Checked,
    Prepared,
    Placed,
    Terminal,
    Refused,
    Uncertain,
    Started,
    Settled,
    Fallback,
    Done,
}
pub struct OrcaAttempt {
    pub(crate) git: Option<crate::NativeGit>,
    policy: Option<crate::orca_policy::OrcaPolicy>,
    strategy_source: OrcaStrategySource,
    before: Option<String>,
    lease: Option<crate::WorkLease>,
    duplicate: bool,
    outcome_cache: Option<Value>,
    id: String,
    pub(crate) task_id: String,
    attempt: u64,
    home: PathBuf,
    pub(crate) spec: OrcaAttemptSpec,
    pub(crate) client: OrcaClient,
    pub(crate) journal: Journal,
    pub(crate) store: TaskStore,
    phase: Phase,
    terminal: Option<String>,
    incarnation: Option<String>,
    worktree: Option<String>,
    created: Option<Value>,
    selector: String,
    dispatch: Option<String>,
    start: Value,
    found: Value,
    waited: Option<Value>,
    started_at: f64,
    ended_at: Option<f64>,
    reattach: bool,
    pub(crate) deadline: Instant,
}
fn now() -> f64 {
    crate::native_run::now()
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
pub fn slice(s: &str, start: usize, end: usize) -> String {
    String::from_utf16_lossy(
        &s.encode_utf16()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect::<Vec<_>>(),
    )
}
fn bounded(s: &str) -> String {
    let s = crate::js_semantics::trim(s);
    slice(if s.is_empty() { "unknown" } else { s }, 0, 4096)
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, BrokerError> {
    v[key].as_str().filter(|s| !s.is_empty()).ok_or_else(denied)
}
// src/exec/orca/state.ts SAFE_ID: ASCII only, no trimming, 1..100 JS units.
fn safe_dispatch_id(id: &str) -> bool {
    (1..=100).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn dispatch_id<'a>(v: &'a Value, key: &str) -> Result<&'a str, BrokerError> {
    v[key]
        .as_str()
        .filter(|s| safe_dispatch_id(s))
        .ok_or_else(denied)
}
pub(crate) fn real(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}
impl OrcaAttempt {
    /// Capture host policy; preparation computes every placement and launch input.
    pub fn from_policy(
        home: &Path,
        task_id: &str,
        policy: crate::orca_policy::OrcaPolicy,
        executable: &str,
        env: HashMap<String, String>,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        Self::from_policy_with_strategy_source(
            home,
            task_id,
            policy,
            OrcaStrategySource::Loaded,
            executable,
            env,
            deadline,
        )
    }
    /// Supply genuine missing-strategy information without treating an invalid
    /// or empty loaded strategy as permission to use the default account.
    pub fn from_policy_with_strategy_source(
        home: &Path,
        task_id: &str,
        policy: crate::orca_policy::OrcaPolicy,
        source: OrcaStrategySource,
        executable: &str,
        env: HashMap<String, String>,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        let task = TaskStore::open(home)?.read(task_id)?.ok_or_else(denied)?;
        let executor = policy.provider["id"]
            .as_str()
            .ok_or_else(denied)?
            .to_owned();
        let repo = task["brief"]["repo"]
            .as_str()
            .ok_or_else(denied)?
            .to_owned();
        let spec = OrcaAttemptSpec {
            executor,
            agent: "codex".into(),
            model: policy.provider["model"].as_str().map(str::to_owned),
            coordinator: String::new(),
            run: String::new(),
            top: repo.clone(),
            base: String::new(),
            sub: String::new(),
            placement: OrcaPlacement::Existing { path: repo },
            notes: vec![],
            prompt: String::new(),
            launch: vec!["codex".into()],
            account_env: HashMap::new(),
        };
        let mut attempt = Self::issue(home, task_id, spec, executable, env, deadline)?;
        attempt.policy = Some(policy);
        attempt.strategy_source = source;
        Ok(attempt)
    }
    pub fn issue(
        home: &Path,
        task_id: &str,
        spec: OrcaAttemptSpec,
        executable: &str,
        env: HashMap<String, String>,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        let mut store = TaskStore::open(home)?;
        let task = store.read(task_id)?.ok_or_else(denied)?;
        let attempt = task["attempts"].as_array().ok_or_else(denied)?.len() as u64 + 1;
        if !pacer_store::is_task_id(task_id)
            || !Path::new(&spec.top).is_absolute()
            || !["codex", "claude"].contains(&spec.agent.as_str())
            || spec.launch.is_empty()
            || spec
                .account_env
                .keys()
                .any(|k| k != "CODEX_HOME" && k != "CLAUDE_CONFIG_DIR")
            || spec.launch.iter().any(|s| s.contains('\0'))
        {
            return Err(denied());
        }
        Ok(Self {
            git: evidence::selected_git(home, &spec.top, &env),
            policy: None,
            strategy_source: OrcaStrategySource::Loaded,
            before: None,
            lease: None,
            duplicate: false,
            outcome_cache: None,
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            attempt,
            home: home.into(),
            client: OrcaClient::new(executable, env, deadline)?,
            journal: Journal::new(home)?,
            store,
            spec,
            phase: Phase::New,
            terminal: None,
            incarnation: None,
            worktree: None,
            created: None,
            selector: String::new(),
            dispatch: None,
            start: Value::Null,
            found: Value::Null,
            waited: None,
            started_at: now(),
            ended_at: None,
            reattach: false,
            deadline,
        })
    }
    fn expect(&self, phases: &[Phase]) -> Result<(), BrokerError> {
        if !phases.contains(&self.phase) {
            return Err(denied());
        }
        Ok(())
    }
    pub(crate) fn task(&mut self) -> Result<Value, BrokerError> {
        Ok(self.task_wire()?.preview().clone())
    }
    pub(crate) fn task_wire(&mut self) -> Result<WireReply, BrokerError> {
        let wire = task_snapshot(&mut self.store, &self.task_id)?.ok_or_else(denied)?;
        let t = wire.preview();
        if t["attempts"]
            .as_array()
            .is_none_or(|a| a.len() as u64 + 1 != self.attempt)
        {
            return Err(denied());
        }
        Ok(wire)
    }
    pub(crate) fn edit(
        &mut self,
        f: impl FnOnce(&mut TaskEdit) -> Result<(), pacer_store::StoreError>,
    ) -> Result<(), BrokerError> {
        let t = self.task()?;
        self.store
            .edit(&self.task_id, crate::native_run::rev(&t)?, now(), f)?;
        Ok(())
    }
    async fn live_answer(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::New])?;
        let task_wire = self.task_wire()?;
        let task = task_wire.preview();
        let asked_id = task["retryOf"].as_str().unwrap_or(&self.task_id).to_owned();
        let asked_wire =
            task_snapshot(&mut self.store, &asked_id)?.unwrap_or_else(|| task_wire.clone());
        let asked = asked_wire.preview();
        let live = &asked["live"];
        if live["backend"] != "orca" {
            self.phase = Phase::Checked;
            return Ok(json!({"kind":"none"}));
        }
        let worker = dispatch_id(live, "worker")?.to_owned();
        let answering = if task["retryOf"].as_str().is_some_and(|s| !s.is_empty()) {
            asked["question"].get("answer").is_some()
        } else {
            task["brief"]["qa"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        };
        let eligible = asked["interactive"] != false
            && answering
            && live["executor"] == self.spec.executor
            && self.client.live_problem(live).await?.is_none();
        if !eligible {
            self.release_live(&asked_id, live).await?;
            self.phase = Phase::Checked;
            return Ok(json!({"kind":"none"}));
        }
        if self.policy.is_some() {
            let prepared = async {
                let top = self
                    .git
                    .as_ref()
                    .ok_or_else(denied)?
                    .text(
                        task["brief"]["repo"].as_str().ok_or_else(denied)?,
                        &["rev-parse", "--show-toplevel"],
                        &[],
                        self.deadline,
                    )
                    .await?;
                let (coordinator, run) =
                    crate::orca_policy::coordinator(&self.client, &mut self.journal, &top).await?;
                self.spec.top = top;
                self.spec.coordinator = coordinator;
                self.spec.run = run;
                Ok::<(), BrokerError>(())
            }
            .await;
            if let Err(error) = prepared {
                self.release_live(&asked_id, live).await?;
                self.phase = Phase::Fallback;
                return Ok(json!({"kind":"fallback","reason":bounded(&error.to_string())}));
            }
        }
        self.reattach = true;
        self.dispatch = Some(worker);
        self.terminal = Some(string(live, "terminal")?.into());
        self.incarnation = live["incarnation"].as_str().map(str::to_owned);
        self.worktree = asked["worktree"].as_str().map(str::to_owned);
        if asked_id != self.task_id {
            self.store
                .edit(&asked_id, crate::native_run::rev(asked)?, now(), |t| {
                    if t.preview().get("live").is_some() {
                        t.remove("/live")?;
                    }
                    t.put("/state", WireReply::new(json!("partial")))?;
                    t.put("/dismissed", WireReply::new(json!(true)))?;
                    t.put("/settledAt", WireReply::new(json!(now())))
                })?;
        }
        self.edit(|t| {
            t.put("/live", asked_wire.subtree("/live")?)?;
            for k in [
                "group",
                "baseBranch",
                "baseSha",
                "startSha",
                "placement",
                "worktree",
            ] {
                if asked.get(k).is_some() {
                    let path = format!("/{k}");
                    t.put(&path, asked_wire.subtree(&path)?)?;
                }
            }
            Ok(())
        })?;
        let dispatch = self.dispatch.clone().ok_or_else(denied)?;
        let id = self.task_id.clone();
        self.journal
            .mutate(|s| {
                if let Some(w) = s["workers"].get_mut(&dispatch) {
                    w["taskId"] = json!(id);
                }
                Ok(())
            })
            .await?;
        if let Some(answer) = task["brief"]["qa"]
            .as_array()
            .and_then(|a| a.last())
            .and_then(|q| q["a"].as_str())
            .filter(|s| !s.is_empty())
        {
            let terminal = self.terminal.as_deref().ok_or_else(denied)?;
            let problem = self.client.live_problem(live).await?;
            let sent = if problem.is_none() {
                self.client
                    .call(
                        &[
                            "terminal",
                            "send",
                            "--terminal",
                            terminal,
                            "--text",
                            answer,
                            "--enter",
                        ],
                        30000,
                    )
                    .await?
            } else {
                Value::Null
            };
            if sent["ok"] != true {
                let id = self.task_id.clone();
                self.release_live(&id, live).await?;
                self.reattach = false;
                self.dispatch = None;
                self.terminal = None;
                self.worktree = None;
                self.phase = Phase::Checked;
                return Ok(json!({"kind":"none"}));
            }
        }
        self.start = json!({"dispatchId":dispatch,"state":"ready"});
        self.lease = Some(crate::WorkLease::begin(
            &self.home,
            &self.task_id,
            &format!("Orca session {}", self.task_id),
        )?);
        if let Some(lease) = &self.lease {
            lease.bind_orca(
                &dispatch,
                self.terminal.as_deref(),
                self.incarnation.as_deref(),
            )?;
        }
        self.before = self.fingerprint().await;
        self.phase = Phase::Started;
        self.started_at = now();
        Ok(json!({"kind":"attached","dispatchId":dispatch}))
    }
    async fn release_live(&mut self, id: &str, live: &Value) -> Result<(), BrokerError> {
        let worker = string(live, "worker")?;
        let terminal = string(live, "terminal")?;
        self.client
            .call(
                &["orchestration", "worker-stop", "--dispatch", worker],
                30000,
            )
            .await?;
        let closed = self.client.close(terminal).await?;
        self.journal
            .mutate(|s| {
                s["workers"].as_object_mut().map(|o| o.remove(worker));
                if !closed {
                    s["unclosed"][terminal] = json!({"taskId":id,"terminal":terminal,"at":now()});
                }
                Ok(())
            })
            .await?;
        let task = self.store.read(id)?.ok_or_else(denied)?;
        self.store
            .edit(id, crate::native_run::rev(&task)?, now(), |t| {
                if t.preview()["live"]["worker"] == worker {
                    t.remove("/live")?;
                }
                Ok(())
            })?;
        Ok(())
    }
    async fn prepare(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Checked])?;
        if let Some(policy) = &self.policy
            && crate::orca_policy::selected_agent(&policy.provider).is_none()
        {
            let id = policy.provider["id"].as_str().unwrap_or("");
            let reply = json!({"ok":false,"reason":format!("Orca terminal execution is not supported for provider \"{id}\""),"refuse":false});
            self.phase = Phase::Fallback;
            return Ok(reply);
        }
        let status = self.client.call(&["status"], 15000).await?;
        if status["ok"] != true
            || status["result"]["runtime"]["state"] != "ready"
            || status["result"]["runtime"]["reachable"] != true
        {
            self.phase = Phase::Fallback;
            return Ok(
                json!({"ok":false,"reason":"the Orca runtime is not ready (orca status)","refuse":false}),
            );
        }
        if let Some(policy) = self.policy.clone() {
            let composed = crate::orca_policy::compose(self, &policy).await;
            match composed {
                Ok(r) if r["ok"] == true => {}
                Ok(r) => {
                    self.phase = Phase::Fallback;
                    return Ok(r);
                }
                Err(e) => {
                    self.phase = Phase::Fallback;
                    return Ok(json!({"ok":false,"reason":bounded(&e.to_string()),"refuse":false}));
                }
            }
        }
        let base = self.spec.base.clone();
        self.edit(|t| t.put("/baseBranch", WireReply::new(json!(base))))?;
        self.lease = Some(crate::WorkLease::begin(
            &self.home,
            &self.task_id,
            &format!("Orca session {}", self.task_id),
        )?);
        self.phase = Phase::Prepared;
        self.started_at = now();
        Ok(
            json!({"ok":true,"agent":self.spec.agent,"model":self.spec.model,"placement":if matches!(self.spec.placement,OrcaPlacement::Existing{..}){"existing"}else{"new-child"},"notes":self.spec.notes.iter().take(8).collect::<Vec<_>>()}),
        )
    }
    async fn place(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Prepared])?;
        self.phase = Phase::Placed;
        let placement = self.spec.placement.clone();
        let reply = match &placement {
            OrcaPlacement::Existing { path } => {
                self.client
                    .call(
                        &[
                            "worktree",
                            "show",
                            "--worktree",
                            &format!("path:{}", real(path).display()),
                        ],
                        30000,
                    )
                    .await?
            }
            OrcaPlacement::NewChild {
                repo_id,
                name,
                base_sha,
                parent,
            } => {
                let repo = format!("id:{repo_id}");
                let mut args = vec![
                    "worktree",
                    "create",
                    "--name",
                    name,
                    "--repo",
                    &repo,
                    "--base-branch",
                    base_sha,
                    "--setup",
                    "skip",
                ];
                if let Some(parent) = parent {
                    args.extend(["--parent-worktree", parent]);
                }
                self.client.call(&args, 30000).await?
            }
        };
        let r = &reply["result"];
        let work = &r["worktree"];
        let checked = checked_worktree(&placement, &self.spec.top, work);
        let (id, path) = match checked {
            Ok(v) if reply["ok"] == true => v,
            _ => {
                return Ok(
                    json!({"ok":false,"reason":"orca worktree does not match the requested worktree"}),
                );
            }
        };
        if matches!(placement, OrcaPlacement::NewChild { .. }) {
            let name = Path::new(&path)
                .file_name()
                .ok_or_else(denied)?
                .to_string_lossy();
            self.created = Some(json!({"id":id,"path":path,"name":name}));
            let mut handles = Vec::new();
            if let Some(h) = r["terminal"]["handle"]
                .as_str()
                .or(r["initialTerminalHandle"].as_str())
                .or(r["terminalHandle"].as_str())
            {
                handles.push(h.to_owned());
            }
            let listed = self
                .client
                .call(
                    &["terminal", "list", "--worktree", &format!("id:{id}")],
                    30000,
                )
                .await?;
            if listed["ok"] == true
                && listed["result"]["truncated"] != true
                && let Some(rows) = listed["result"]["terminals"].as_array()
            {
                for row in rows {
                    if row["worktreeId"] == id
                        && let Some(h) = row["handle"].as_str()
                        && !handles.contains(&h.to_owned())
                    {
                        handles.push(h.into());
                    }
                }
            } else if !handles.is_empty() {
                let owned = self.created.clone().ok_or_else(denied)?;
                let task = self.task_id.clone();
                self.journal
                    .mutate(|s| {
                        s["strays"][&id] = owned;
                        s["strays"][&id]["taskId"] = json!(task);
                        s["strays"][&id]["initial"] = json!(handles);
                        s["strays"][&id]["at"] = json!(now());
                        Ok(())
                    })
                    .await?;
            }
            for h in handles {
                if !self.client.close(&h).await? {
                    self.record_unclosed(&h).await?;
                    return Ok(
                        json!({"ok":false,"reason":"orca worktree initial terminal could not be verified closed"}),
                    );
                }
            }
        }
        self.selector = format!("id:{id}");
        self.worktree = Some(match placement {
            OrcaPlacement::Existing { path } => {
                if self.policy.is_some() {
                    let task = self.task()?;
                    if task["retryOf"].is_string() {
                        task["worktree"].as_str().unwrap_or(&path).to_owned()
                    } else {
                        task["brief"]["repo"].as_str().unwrap_or(&path).to_owned()
                    }
                } else {
                    path
                }
            }
            OrcaPlacement::NewChild { .. } => {
                if self.spec.sub.is_empty() {
                    path
                } else {
                    Path::new(&path)
                        .join(&self.spec.sub)
                        .to_string_lossy()
                        .into_owned()
                }
            }
        });
        if self.policy.is_some()
            && self.task()?["placement"]["mode"] == "current"
            && self.task()?.get("startSha").is_none()
        {
            let git = self.git.as_ref().ok_or_else(denied)?;
            let sha = git
                .text(
                    self.worktree.as_deref().ok_or_else(denied)?,
                    &["rev-parse", "--verify", "-q", "HEAD"],
                    &[],
                    self.deadline,
                )
                .await?;
            if !(40..=64).contains(&sha.len())
                || !sha
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(denied());
            }
            self.edit(|t| {
                if t.preview().get("startSha").is_none() {
                    t.put("/startSha", WireReply::new(json!(sha)))?;
                }
                Ok(())
            })?;
        }
        Ok(json!({"ok":true,"worktreeId":id,"workdir":self.worktree}))
    }
    async fn create_terminal(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Placed])?;
        if self.selector.is_empty() {
            return Err(denied());
        }
        self.phase = Phase::Terminal;
        let run = self
            .home
            .join("runs")
            .join(&self.task_id)
            .join(format!("{}-orca", self.attempt));
        if let Some(policy) = self.policy.clone() {
            self.compose_launch(&policy, &run).await?;
        }
        let mut args = vec!["exec".into(), "env".into()];
        let home = if self.spec.agent == "codex" {
            "CODEX_HOME"
        } else {
            "CLAUDE_CONFIG_DIR"
        };
        if !self.spec.account_env.contains_key(home) {
            args.extend(["-u".into(), home.into()]);
        }
        args.extend([
            "PACER_ROLE=executor".into(),
            format!("PACER_TASK_ID={}", self.task_id),
            format!("PACER_HOME={}", self.home.display()),
            format!("PACER_RUN_DIR={}", run.display()),
            format!(
                "PACER_TRANSCRIPT_REPORT={}",
                run.join("transcript-report.md").display()
            ),
        ]);
        if self.spec.agent == "claude" {
            args.push("CLAUDE_CODE_SANDBOXED=1".into());
        }
        args.extend(
            self.spec
                .account_env
                .iter()
                .map(|(k, v)| format!("{k}={v}")),
        );
        if let Some(port) = self
            .policy
            .as_ref()
            .and_then(|p| p.login.env.get("PACER_PORT"))
            .filter(|s| !s.is_empty())
        {
            args.push(format!("PACER_PORT={port}"));
        }
        args.extend(self.spec.launch.clone());
        let command = args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ");
        let title = format!("pacer {}", self.task_id);
        let reply = self
            .client
            .call(
                &[
                    "terminal",
                    "create",
                    "--worktree",
                    &self.selector,
                    "--title",
                    &title,
                    "--command",
                    &command,
                ],
                30000,
            )
            .await?;
        let r = &reply["result"]["terminal"];
        if reply["ok"] != true || r["handle"].as_str().is_none_or(str::is_empty) {
            return Ok(json!({"ok":false,"reason":"orca terminal create failed"}));
        }
        self.terminal = Some(string(r, "handle")?.into());
        self.incarnation = r["incarnationId"].as_str().map(str::to_owned);
        let terminal = self.terminal.as_deref().ok_or_else(denied)?;
        if let Some(lease) = &self.lease {
            lease.bind_orca("pending", Some(terminal), self.incarnation.as_deref())?;
        }
        let idle = self
            .client
            .call(
                &[
                    "terminal",
                    "wait",
                    "--terminal",
                    terminal,
                    "--for",
                    "tui-idle",
                    "--timeout-ms",
                    "60000",
                ],
                65000,
            )
            .await?;
        if idle["ok"] != true || idle["result"]["wait"]["satisfied"] != true {
            return Ok(json!({"ok":false,"reason":"orca terminal did not become idle"}));
        }
        Ok(json!({"ok":true,"terminal":terminal,"incarnationId":self.incarnation}))
    }
    async fn start_worker(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Terminal])?;
        let terminal = self.terminal.clone().ok_or_else(denied)?;
        let request = format!(
            "{}\0{}\0{}",
            real(self.home.to_str().ok_or_else(denied)?).display(),
            self.task_id,
            self.attempt
        );
        let request_id = format!("{:x}", Sha256::digest(request.as_bytes()))[..32].to_owned();
        let id = self.task_id.clone();
        let attempt = self.attempt;
        let run = self.spec.run.clone();
        let owned = self.created.clone();
        let mut duplicate = false;
        let intent = self.journal.mutate(|s| {
            duplicate = ["starting", "uncertain", "workers"].iter().any(|key| {
                s[*key].as_object().is_some_and(|rows| rows.values().any(|row| {
                    row["taskId"] == id && crate::js_semantics::safe_u64(&row["attempt"]) == Some(attempt)
                }))
            });
            if duplicate { return Err(BrokerError::Effect("an Orca worker start for this attempt is already recorded; a second start is refused".into())); }
            s["starting"][&terminal] = json!({"taskId":id,"attempt":attempt,"terminal":terminal,"run":run,"requestId":request_id,"worktree":owned,"at":now(),"pid":std::process::id()});
            Ok(())
        }).await;
        self.duplicate = duplicate;
        intent?;
        self.phase = Phase::Uncertain;
        let reply = self
            .client
            .call(
                &[
                    "orchestration",
                    "worker-start",
                    "--spec",
                    &self.spec.prompt,
                    "--terminal",
                    &terminal,
                    "--worktree",
                    &self.selector,
                    "--run",
                    &self.spec.run,
                    "--from",
                    &self.spec.coordinator,
                ],
                240000,
            )
            .await;
        match reply {
            Ok(reply)
                if reply["ok"] == true
                    && reply["result"]["dispatchId"]
                        .as_str()
                        .is_some_and(safe_dispatch_id) =>
            {
                self.bind(reply["result"].clone()).await?;
                self.started()
            }
            Ok(reply) if reply["ok"] == false && reply["error"]["code"] == "task_not_startable" => {
                self.forget_intent().await?;
                self.phase = Phase::Refused;
                Ok(
                    json!({"kind":"refused","code":"task_not_startable","message":reply["error"]["message"]}),
                )
            }
            _ => Ok(json!({"kind":"uncertain","reason":"orca worker-start result is uncertain"})),
        }
    }
    fn started(&self) -> Result<Value, BrokerError> {
        Ok(
            json!({"kind":"started","dispatchId":self.dispatch.as_deref().ok_or_else(denied)?,"state":self.start["state"],"stage":self.start["stage"],"failedStage":self.start["failedStage"],"lastError":self.start["lastError"]}),
        )
    }
    async fn forget_intent(&mut self) -> Result<(), BrokerError> {
        let terminal = self.terminal.as_deref().ok_or_else(denied)?;
        self.journal
            .mutate(|s| {
                for key in ["starting", "uncertain"] {
                    s[key].as_object_mut().map(|o| o.remove(terminal));
                }
                Ok(())
            })
            .await
    }
    async fn bind(&mut self, start: Value) -> Result<(), BrokerError> {
        self.dispatch = Some(dispatch_id(&start, "dispatchId")?.into());
        self.start = start;
        self.phase = Phase::Started;
        self.started_at = now();
        self.before = self.fingerprint().await;
        if let Some(lease) = &self.lease {
            let _ = lease.bind_orca(
                self.dispatch.as_deref().ok_or_else(denied)?,
                self.terminal.as_deref(),
                self.incarnation.as_deref(),
            );
        }
        let dispatch = self.dispatch.clone().ok_or_else(denied)?;
        let id = self.task_id.clone();
        let executor = self.spec.executor.clone();
        let terminal = self.terminal.clone();
        let work = self.worktree.clone();
        let attempt = self.attempt;
        let started = self.started_at;
        self.journal.mutate(|s|{s["workers"][&dispatch]=json!({"dispatchId":dispatch,"taskId":id,"attempt":attempt,"executor":executor,"worktree":work,"terminal":terminal,"startedAt":started});Ok(())}).await?;
        let agent = self.spec.agent.clone();
        let inc = self.incarnation.clone();
        self.edit(|t| {
            if let Some(w) = work {
                t.put("/worktree", WireReply::new(json!(w)))?;
            }
            if t.preview()["interactive"] != false {
                let mut live = json!({
                    "backend": "orca", "worker": dispatch, "terminal": terminal,
                    "executor": executor, "agent": agent, "since": started
                });
                if let Some(inc) = inc {
                    live["incarnation"] = json!(inc);
                }
                t.put("/live", WireReply::new(live))?;
            }
            Ok(())
        })?;
        self.forget_intent().await
    }
    async fn record_unclosed(&mut self, terminal: &str) -> Result<(), BrokerError> {
        let id = &self.task_id;
        self.journal
            .mutate(|s| {
                s["unclosed"][terminal] = json!({"taskId":id,"terminal":terminal,"at":now()});
                Ok(())
            })
            .await
    }
    async fn abandon(&mut self, reason: &str) -> Result<Value, BrokerError> {
        self.expect(&[
            Phase::Prepared,
            Phase::Placed,
            Phase::Terminal,
            Phase::Refused,
        ])?;
        if let Some(t) = self.terminal.clone() {
            if !self.client.close(&t).await? {
                self.record_unclosed(&t).await?;
            } else if let Some(lease) = &self.lease {
                lease.finish()?;
            }
        }
        self.discard().await?;
        if self.terminal.is_none()
            && let Some(lease) = &self.lease
        {
            lease.finish()?;
        }
        self.phase = Phase::Fallback;
        Ok(json!({"reason":bounded(reason)}))
    }
    async fn discard(&mut self) -> Result<(), BrokerError> {
        if let Some(w) = self.created.clone() {
            let id = string(&w, "id")?;
            let path = string(&w, "path")?;
            let shown = self
                .client
                .call(
                    &["worktree", "show", "--worktree", &format!("id:{id}")],
                    30000,
                )
                .await?;
            let owned = shown["ok"] == true
                && shown["result"]["worktree"]["id"] == id
                && shown["result"]["worktree"]["isMainWorktree"] != true
                && shown["result"]["worktree"]["displayName"] == w["name"]
                && shown["result"]["worktree"]["path"]
                    .as_str()
                    .is_some_and(|actual| real(actual) == real(path));
            let removed = if owned {
                self.client
                    .call(
                        &[
                            "worktree",
                            "rm",
                            "--worktree",
                            &format!("id:{id}"),
                            "--force",
                        ],
                        60000,
                    )
                    .await?["ok"]
                    == true
            } else {
                false
            };
            let missing = shown["ok"] == false && shown["error"]["code"] == "selector_not_found";
            let mut settled = missing;
            if removed {
                for _ in 0..20 {
                    if !Path::new(path).exists() {
                        settled = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
            let task = &self.task_id;
            self.journal
                .mutate(|s| {
                    if removed {
                        s["removed"][id] = json!({"id":id,"path":path,"at":now()});
                    }
                    if !settled {
                        s["stranded"][task] = w.clone();
                        s["stranded"][task]["taskId"] = json!(task);
                        s["stranded"][task]["at"] = json!(now());
                    }
                    Ok(())
                })
                .await?;
        }
        Ok(())
    }
    async fn unstarted(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Uncertain])?;
        if self.found["kind"] == "found" {
            return Err(denied());
        }
        let terminal = self.terminal.clone().ok_or_else(denied)?;
        if self.found["kind"] == "none" && self.client.close(&terminal).await? {
            if let Some(lease) = &self.lease {
                lease.finish()?;
            }
            self.discard().await?;
            self.forget_intent().await?;
        } else {
            let id = &self.task_id;
            let run = &self.spec.run;
            let owned = &self.created;
            let attempt = self.attempt;
            self.journal.mutate(|s|{s["uncertain"][&terminal]=json!({"taskId":id,"attempt":attempt,"terminal":terminal,"run":run,"worktree":owned,"at":now()});s["starting"].as_object_mut().map(|o|o.remove(&terminal));Ok(())}).await?;
        }
        self.phase = Phase::Done;
        let outcome=self.outcome(&json!({"code":1,"timedOut":false,"settled":false,"summary":"pacer cannot tell whether Orca created the worker. Direct fallback was skipped to avoid duplicate execution."}))?;
        self.outcome_cache = Some(outcome.clone());
        Ok(outcome)
    }
    fn outcome(&self, m: &Value) -> Result<Value, BrokerError> {
        let summary = m["summary"].as_str().unwrap_or_default();
        let tail = m["tail"].as_str().unwrap_or_default();
        let report = if self.reattach {
            summary.to_owned()
        } else {
            self.spec
                .notes
                .iter()
                .map(String::as_str)
                .chain([summary])
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        let log = self
            .home
            .join("tasks")
            .join(format!("{}.{}.log", self.task_id, self.spec.executor));
        if self.spec.executor.contains(['/', '\\']) {
            return Err(denied());
        }
        let directory = self
            .home
            .join("tasks")
            .to_str()
            .ok_or_else(denied)?
            .to_owned();
        let path = log.to_str().ok_or_else(denied)?.to_owned();
        let mut writer = crate::NativeWrite::prepare(
            &self.home,
            &[
                crate::WriteResource {
                    path: directory.clone(),
                    kind: "directory".into(),
                    operations: vec!["mkdir".into()],
                },
                crate::WriteResource {
                    path: path.clone(),
                    kind: "file".into(),
                    operations: vec!["write".into()],
                },
            ],
        )?;
        writer.answer("capability.fs.mkdir", &json!({"path":directory}))?;
        writer.write_bytes(
            &path,
            format!("--- summary\n{summary}\n--- worker output (tail)\n{tail}\n").as_bytes(),
        )?;
        let tail_chars = |s: &str, n: usize| {
            slice(
                s,
                crate::js_semantics::utf16_len(s).saturating_sub(n),
                usize::MAX,
            )
        };
        let mut result = json!({"exec":{"code":m["code"],"stdout":tail_chars(summary,262144),"stderr":tail_chars(tail,262144),"timedOut":m["timedOut"]},"report":tail_chars(&report,4000),"backend":"orca","attempt":{"executor":self.spec.executor,"model":self.spec.model,"startedAt":self.started_at,"endedAt":self.ended_at.unwrap_or_else(now),"exitCode":m["code"],"timedOut":m["timedOut"],"limitHit":false,"log":path}});
        if let Some(work) = &self.worktree {
            result["worktree"] = json!(work);
        }
        Ok(result)
    }
}
impl OrcaAttempt {
    async fn invoke_value(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        self.task()?;
        match method {
            "liveAnswer" => self.live_answer().await,
            "prepare" => self.prepare().await,
            "place" => self.place().await,
            "terminal" => self.create_terminal().await,
            "abandon" => {
                self.abandon(params["reason"].as_str().ok_or_else(denied)?)
                    .await
            }
            "start" => self.start_worker().await,
            "lookup" => {
                self.expect(&[Phase::Uncertain])?;
                self.found = self
                    .client
                    .lookup(&self.spec.run, self.terminal.as_deref().ok_or_else(denied)?)
                    .await?;
                let mut wire = self.found.clone();
                if let Some(state) = wire["state"].as_str() {
                    wire["state"] = json!(slice(state, 0, 256));
                }
                if let Some(reason) = wire["reason"].as_str() {
                    wire["reason"] = json!(bounded(reason));
                }
                Ok(wire)
            }
            "adopt" => {
                self.expect(&[Phase::Uncertain])?;
                if self.found["kind"] != "found" {
                    return Err(denied());
                }
                let start = json!({"dispatchId":self.found["dispatchId"],"state":if self.found["state"]=="failed"{"failed"}else{"ready"}});
                self.bind(start).await?;
                self.started()
            }
            "unstarted" => self.unstarted().await,
            "wait" => self.wait().await,
            "settle" => {
                self.settle(params["settled"].as_bool().ok_or_else(denied)?)
                    .await?;
                Ok(json!({"ok":true}))
            }
            "finish" => self.finish(&params).await,
            _ => Err(denied()),
        }
    }
}
pub fn checked_worktree(
    placement: &OrcaPlacement,
    top: &str,
    w: &Value,
) -> Result<(String, String), BrokerError> {
    let id = string(w, "id")?;
    let (repo, path) = id
        .split_once("::")
        .filter(|(r, p)| !r.is_empty() && p.starts_with('/'))
        .ok_or_else(denied)?;
    if w["path"]
        .as_str()
        .is_some_and(|p| !p.is_empty() && real(p) != real(path))
    {
        return Err(denied());
    }
    match placement {
        OrcaPlacement::NewChild { repo_id, name, .. } => {
            if repo != repo_id
                || Path::new(path).file_name().and_then(|s| s.to_str()) != Some(name)
                || real(path) == real(top)
            {
                return Err(denied());
            }
        }
        OrcaPlacement::Existing { path: want } => {
            let want = real(want);
            let actual = real(path);
            if !want.starts_with(actual) {
                return Err(denied());
            }
        }
    }
    Ok((id.into(), path.into()))
}
/// Concrete task-live owner for stop and inspect calls. No terminal or worker
/// handle supplied by a provider can select the effect target.
pub struct OrcaLiveOwner {
    git: Option<crate::NativeGit>,
    deadline: Instant,
    home: PathBuf,
    task_id: String,
    live: Value,
    client: OrcaClient,
    journal: Journal,
}
impl OrcaLiveOwner {
    pub fn issue(
        home: &Path,
        task_id: &str,
        executable: &str,
        env: HashMap<String, String>,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        let mut store = TaskStore::open(home)?;
        let task = store.read(task_id)?.ok_or_else(denied)?;
        if task["live"]["backend"] != "orca" {
            return Err(denied());
        }
        Ok(Self {
            git: task["brief"]["repo"]
                .as_str()
                .and_then(|repo| evidence::selected_git(home, repo, &env)),
            deadline,
            home: home.into(),
            task_id: task_id.into(),
            live: task["live"].clone(),
            client: OrcaClient::new(executable, env, deadline)?,
            journal: Journal::new(home)?,
        })
    }
    fn matches(
        &self,
        worker: &str,
        terminal: &str,
        incarnation: Option<&str>,
    ) -> Result<(), BrokerError> {
        if self.live["worker"] != worker
            || self.live["terminal"] != terminal
            || self.live["incarnation"].as_str() != incarnation
        {
            return Err(denied());
        }
        Ok(())
    }
}
impl crate::OrcaLiveControl for OrcaLiveOwner {
    async fn problem(
        &mut self,
        worker: &str,
        terminal: &str,
        incarnation: Option<&str>,
    ) -> Result<Option<String>, BrokerError> {
        self.matches(worker, terminal, incarnation)?;
        self.client.live_problem(&self.live).await
    }
    async fn release(
        &mut self,
        worker: &str,
        terminal: &str,
        incarnation: Option<&str>,
        _why: &str,
    ) -> Result<(), BrokerError> {
        self.matches(worker, terminal, incarnation)?;
        let task = TaskStore::open(&self.home)?
            .read(&self.task_id)?
            .ok_or_else(denied)?;
        let release = ["stopped", "done", "partial", "failed", "limit"]
            .contains(&task["state"].as_str().unwrap_or(""));
        let lane = if release {
            if let Some(git) = &self.git {
                lane::live_lane(
                    &self.client,
                    &self.journal,
                    git,
                    &task,
                    &self.live,
                    self.deadline,
                )
                .await
                .ok()
                .flatten()
            } else {
                None
            }
        } else {
            None
        };
        let stopped = self
            .client
            .call(
                &["orchestration", "worker-stop", "--dispatch", worker],
                30000,
            )
            .await;
        let closed = self.client.close(terminal).await?;
        let id = &self.task_id;
        self.journal
            .mutate(|s| {
                s["workers"].as_object_mut().map(|o| o.remove(worker));
                if !closed {
                    s["unclosed"][terminal] = json!({"taskId":id,"terminal":terminal,"at":now()});
                }
                Ok(())
            })
            .await?;
        let mut store = TaskStore::open(&self.home)?;
        let task = store.read(id)?.ok_or_else(denied)?;
        store.edit(id, crate::native_run::rev(&task)?, now(), |t| {
            if t.preview()["live"]["worker"] == worker {
                t.remove("/live")?;
            }
            Ok(())
        })?;
        let _ = lane::release_lane(
            &self.home,
            &task,
            lane.as_ref(),
            &self.client,
            &mut self.journal,
            self.git.as_ref(),
            self.deadline,
            release,
        )
        .await;
        stopped?;
        Ok(())
    }
}
