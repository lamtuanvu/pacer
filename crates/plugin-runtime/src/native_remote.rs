//! Journaled remote executor effects;
//! Provider input contains task identity only.
use crate::{
    AuthorityError, BrokerError, CapabilityEffect,
    native_run::{directory::RunDirectory, rev},
};

use pacer_store::TaskStore;

use serde::{Deserialize, Serialize};

use serde_json::{Value, json};

use std::{
    collections::HashSet,
    future::Future,
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIntent {
    pub attempt: u64,
    pub provider_id: String,
    pub executor: String,
    pub alias: String,
    pub host_fingerprint: String,
    pub repo_top: String,
    pub origin_hash: String,
    pub checkout: String,
    pub tag: String,
    pub base_sha: String,
    pub base: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RemoteOperation {
    Prepare,
    Recover,
    PrepareBundle,
    Start,
    Read,
    Stop,
    Report,
    Preflight,
    Transfer,
}

/// Host-side fixed-script/transfer owner. Neither targets nor script source come from RPC.
pub trait RemoteHost {
    fn fingerprint(&self) -> String;

    fn invoke(
        &mut self,
        operation: RemoteOperation,
        private: &Value,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
}

pub struct NativeRemote<H> {
    store: TaskStore,
    home: PathBuf,
    id: String,
    intent: RemoteIntent,
    host: H,
    launch: Value,
    deadline: Instant,
    mode: RemoteOperation,
    used: HashSet<String>,
    prepared: Option<(String, String)>,
    dir: Option<RunDirectory>,
    run: Option<Value>,
    stop_grant: Option<(u64, Value)>,
    source_repo: Value,
}

fn denied() -> BrokerError {
    AuthorityError::Denied("owned remote run or configured host changed".into()).into()
}

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64 / 1000.0)
}

fn core(v: &Value) -> Value {
    let mut value = v.clone();

    if let Some(o) = value.as_object_mut() {
        o.remove("missingBaseReceiptAt");

        o.remove("bundleRetryIssuedAt");
    }

    value
}

fn sha(s: &str) -> bool {
    (40..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl<H: RemoteHost> NativeRemote<H> {
    pub fn issue(
        home: &Path,
        id: &str,
        intent: RemoteIntent,
        host: H,
        launch: Value,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        if !pacer_store::is_task_id(id)
            || intent.provider_id != "pacer-exec-direct"
            || intent.attempt == 0
            || intent.attempt > 9_007_199_254_740_991
            || !sha(&intent.base_sha)
            || intent.base.is_empty()
            || crate::js_semantics::utf16_len(&intent.base) > 256
            || intent.base.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            || !intent.executor.ends_with(&format!("@{}", intent.alias))
            || host.fingerprint() != intent.host_fingerprint
            || !Path::new(&intent.repo_top).is_absolute()
        {
            return Err(denied());
        }

        let mut store = TaskStore::open(home)?;

        let task = store.read(id)?.ok_or_else(denied)?;

        let expected = serde_json::to_value(&intent).map_err(|_| denied())?;

        if task["state"] != "running"
            || (task.get("stopPending").is_some() && task.get("run").is_none())
            || task["executorProvider"] != intent.provider_id
            || task["executor"] != intent.executor
            || task["attempts"]
                .as_array()
                .is_none_or(|a| a.len() as u64 + 1 != intent.attempt)
        {
            return Err(denied());
        }

        let mode = if let Some(prior) = task.get("remotePrepareIntent") {
            if !crate::js_semantics::json_equal(&core(prior), &expected) {
                return Err(denied());
            }

            if prior.get("missingBaseReceiptAt").is_some()
                && prior.get("bundleRetryIssuedAt").is_none()
            {
                RemoteOperation::PrepareBundle
            } else {
                RemoteOperation::Recover
            }
        } else {
            if task.get("run").is_some() {
                return Err(denied());
            }

            store.update(id, rev(&task)?, now(), |t| {
                t["remotePrepareIntent"] = expected
            })?;

            RemoteOperation::Prepare
        };

        let mut owner = Self {
            store,
            home: home.into(),
            id: id.into(),
            intent,
            host,
            launch,
            deadline,
            mode,
            used: HashSet::new(),
            prepared: None,
            dir: None,
            run: None,
            stop_grant: None,
            source_repo: task["brief"]["repo"].clone(),
        };
        if let Some(run) = task.get("run") {
            let dir = RunDirectory::existing(home, id, owner.intent.attempt)?;
            let work = run["workdir"].as_str().ok_or_else(denied)?;
            let suffix = format!(
                "/.pacer-remote/worktrees/{}/{}-{}",
                owner.intent.tag, id, owner.intent.attempt
            );
            let prefix = work
                .strip_suffix(&suffix)
                .filter(|s| s.starts_with('/') && *s != "/")
                .ok_or_else(denied)?;
            if run["dir"] != json!(dir.path)
                || run["host"] != owner.intent.alias
                || run["remoteWorktree"] != work
                || run["baseSha"] != owner.intent.base_sha
                || run["remoteDir"]
                    != format!("{prefix}/.pacer-remote/runs/{id}/{}", owner.intent.attempt)
                || ![
                    format!("pacer/{id}"),
                    format!("pacer/{id}-{}", owner.intent.attempt),
                ]
                .contains(&run["remoteBranch"].as_str().unwrap_or_default().to_owned())
            {
                return Err(denied());
            }
            owner.dir = Some(dir);
            owner.run = Some(run.clone());
            owner.owner()?;
        }
        Ok(owner)
    }

    pub fn with_stop_grant(mut self, grace_ms: u64) -> Result<Self, BrokerError> {
        if grace_ms > 25000 {
            return Err(BrokerError::Invalid("graceMs"));
        }
        let task = self.owner()?;
        let pending = task["stopPending"].clone();
        if pending["attempt"].as_f64() != Some(self.intent.attempt as f64)
            || pending["providerId"] != self.intent.provider_id
            || pending["graceMs"].as_f64() != Some(grace_ms as f64)
        {
            return Err(denied());
        }
        self.stop_grant = Some((grace_ms, pending));
        Ok(self)
    }
    fn active(&self) -> Result<(), BrokerError> {
        if Instant::now() >= self.deadline {
            return Err(BrokerError::Timeout);
        }

        if self.host.fingerprint() != self.intent.host_fingerprint {
            return Err(denied());
        }

        Ok(())
    }

    fn task(&mut self) -> Result<Value, BrokerError> {
        self.active()?;

        let task = self.store.read(&self.id)?.ok_or_else(denied)?;

        let expected = serde_json::to_value(&self.intent).map_err(|_| denied())?;

        if task["state"] != "running"
            || task["brief"]["repo"] != self.source_repo
            || task["executorProvider"] != self.intent.provider_id
            || task["executor"] != self.intent.executor
            || task["attempts"]
                .as_array()
                .is_none_or(|a| a.len() as u64 + 1 != self.intent.attempt)
            || !crate::js_semantics::json_equal(&core(&task["remotePrepareIntent"]), &expected)
        {
            return Err(denied());
        }

        Ok(task)
    }

    fn owner(&mut self) -> Result<Value, BrokerError> {
        let t = self.task()?;

        let expected = self.run.as_ref().ok_or_else(denied)?;

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
            if !crate::js_semantics::json_option_equal(t["run"].get(key), expected.get(key)) {
                return Err(denied());
            }
        }

        if t["worktree"]
            != format!(
                "{}:{}",
                self.intent.alias,
                expected["workdir"].as_str().ok_or_else(denied)?
            )
        {
            return Err(denied());
        }

        self.dir.as_ref().ok_or_else(denied)?.check()?;

        Ok(t)
    }

    async fn effect(&mut self, op: RemoteOperation, extra: Value) -> Result<Value, BrokerError> {
        self.active()?;

        let private = json!({
        "intent":self.intent,"taskId":self.id,"run":self.run,"launch":self.launch,"extra":extra}
        );

        let result = tokio::time::timeout_at(self.deadline.into(), self.host.invoke(op, &private))
            .await
            .map_err(|_| BrokerError::Timeout)??;

        self.active()?;

        Ok(result)
    }

    pub async fn answer(&mut self, method: &str, p: &Value) -> Result<Value, BrokerError> {
        self.active()?;

        let stop = method == "capability.hosts.stopOwned";

        if p.as_object().is_none_or(|o| {
            o.keys().any(|k| {
                !if stop {
                    ["taskId", "attempt", "graceMs"].as_slice()
                } else {
                    ["taskId", "attempt"].as_slice()
                }
                .contains(&k.as_str())
            })
        }) || p["taskId"] != self.id
            || p.get("attempt").and_then(crate::js_semantics::safe_u64) != Some(self.intent.attempt)
        {
            return Err(denied());
        }

        match method {
            "capability.hosts.prepareOwned" => self.prepare().await,
            "capability.hosts.claimOwned" => self.claim(),
            "capability.hosts.startOwned" => self.start().await,
            "capability.hosts.pollOwned" => self.poll().await,
            "capability.hosts.readOwnedOutput" => self.output(),
            "capability.hosts.stopOwned" => {
                let grace = p
                    .get("graceMs")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|n| *n <= 25000)
                    .ok_or(BrokerError::Invalid("graceMs"))?;

                self.stop(grace).await
            }

            "capability.hosts.transferOwned" => self.transfer().await,
            _ => Err(BrokerError::Invalid("remote owned method")),
        }
    }

    async fn prepare(&mut self) -> Result<Value, BrokerError> {
        if !self.used.insert("prepare".into()) {
            return Err(denied());
        }

        let before = self.task()?;

        if before.get("run").is_some() || before.get("stopPending").is_some() {
            return Err(denied());
        }

        if self.mode == RemoteOperation::PrepareBundle {
            self.retry_marker()?;
        }

        let mut result = self.effect(self.mode, Value::Null).await?;

        if self.mode == RemoteOperation::Prepare
            && result["timedOut"] == false
            && result["code"].as_f64() == Some(3.0)
            && result["stdout"] == ""
            && result["stderr"]
                .as_str()
                .is_some_and(|s| crate::js_semantics::trim(s) == "missing-base")
        {
            let t = self.task()?;

            if t["remotePrepareIntent"]
                .get("missingBaseReceiptAt")
                .is_some()
                || t["remotePrepareIntent"]
                    .get("bundleRetryIssuedAt")
                    .is_some()
            {
                return Err(denied());
            }

            self.store.update(&self.id, rev(&t)?, now(), |t| {
                t["remotePrepareIntent"]["missingBaseReceiptAt"] = json!(now())
            })?;

            self.retry_marker()?;

            result = self
                .effect(RemoteOperation::PrepareBundle, Value::Null)
                .await?;
        }

        let current = self.task()?;

        if current.get("run").is_some()
            || current.get("stopPending").is_some()
            || result["code"].as_f64() != Some(0.0)
            || result["timedOut"] != false
        {
            return Err(BrokerError::Effect("remote placement is unverified".into()));
        }

        let text = result["stdout"].as_str().ok_or_else(denied)?;

        let text =
            text.trim_end_matches(|c: char| crate::js_semantics::trim(&c.to_string()).is_empty());

        let lines: Vec<_> = text.split('\n').collect();

        if lines.len() != 2 {
            return Err(denied());
        }

        let worktree = lines[0].strip_prefix("worktree=").ok_or_else(denied)?;

        let branch = lines[1].strip_prefix("branch=").ok_or_else(denied)?;

        let suffix = format!(
            "/.pacer-remote/worktrees/{}/{}-{}",
            self.intent.tag, self.id, self.intent.attempt
        );

        let prefix = worktree
            .strip_suffix(&suffix)
            .filter(|p| p.starts_with('/') && *p != "/")
            .ok_or_else(denied)?;

        if !Path::new(worktree).is_absolute()
            || crate::authority::normalize_path(worktree) != worktree
            || prefix.split('/').any(|p| p == "..")
            || ![
                format!("pacer/{}", self.id),
                format!("pacer/{}-{}", self.id, self.intent.attempt),
            ]
            .contains(&branch.to_owned())
        {
            return Err(denied());
        }

        self.prepared = Some((worktree.into(), branch.into()));

        Ok(json!({
        "worktree":worktree,"branch":branch}
        ))
    }

    fn retry_marker(&mut self) -> Result<(), BrokerError> {
        let t = self.task()?;

        if t["remotePrepareIntent"]
            .get("missingBaseReceiptAt")
            .is_none()
            || t["remotePrepareIntent"]
                .get("bundleRetryIssuedAt")
                .is_some()
        {
            return Err(denied());
        }

        self.store.update(&self.id, rev(&t)?, now(), |t| {
            t["remotePrepareIntent"]["bundleRetryIssuedAt"] = json!(now())
        })?;

        Ok(())
    }

    fn claim(&mut self) -> Result<Value, BrokerError> {
        let (worktree, branch) = self.prepared.clone().ok_or_else(denied)?;

        let t = self.task()?;

        if t.get("run").is_some() || t.get("stopPending").is_some() {
            return Err(denied());
        }

        let suffix = format!(
            "/.pacer-remote/worktrees/{}/{}-{}",
            self.intent.tag, self.id, self.intent.attempt
        );

        let prefix = worktree.strip_suffix(&suffix).ok_or_else(denied)?;

        let remote_dir = format!(
            "{prefix}/.pacer-remote/runs/{}/{}",
            self.id, self.intent.attempt
        );

        let path = self
            .home
            .join("runs")
            .join(&self.id)
            .join(self.intent.attempt.to_string());

        let expected = json!({
        "attempt":self.intent.attempt,"providerId":self.intent.provider_id,"executor":self.intent.executor,"workdir":worktree,"dir":path,"host":self.intent.alias,"remoteDir":remote_dir,"remoteBranch":branch,"baseSha":self.intent.base_sha}
        );

        let recover = t.get("runClaim").is_some();

        if recover && t["runClaim"] != expected {
            return Err(denied());
        }

        let home = self.home.clone();

        let id = self.id.clone();

        let intent = self.intent.clone();

        let (run,dir)=self.store.with_task_lock(&id,|locked|{
let mut current=locked.read()?;
if current["rev"]!=t["rev"]{
return Err(denied());
}
if !recover{
current=locked.update(rev(&current)?,now(),|t|t["runClaim"]=expected.clone())?;
}
let dir=RunDirectory::claim(&home,&id,intent.attempt,recover)?;
let run=json!({
"dir":path,"attempt":intent.attempt,"executor":intent.executor,"startedAt":now(),"mode":"new","workdir":worktree,"logFile":path.join("stdout"),"host":intent.alias,"remoteDir":remote_dir,"remoteWorktree":worktree,"remoteBranch":branch,"baseSha":intent.base_sha}
);
locked.update(rev(&current)?,now(),|t|{
t["run"]=run.clone();
t["baseBranch"]=json!(intent.base);
t["baseSha"]=json!(intent.base_sha);
t["worktree"]=json!(format!("{}:{worktree}",intent.alias));
t.as_object_mut().map(|o|o.remove("runClaim"));
}
)?;
Ok((run,dir))}
)?;

        let result = json!({
        "dir":run["dir"],"worktree":worktree,"remoteDir":remote_dir,"branch":branch,"startedAt":run["startedAt"],"logFile":run["logFile"]}
        );

        self.run = Some(run);

        self.dir = Some(dir);

        Ok(result)
    }

    async fn start(&mut self) -> Result<Value, BrokerError> {
        if self.prepared.is_none() || !self.used.insert("start".into()) {
            return Err(denied());
        }

        let t = self.owner()?;

        if ["stopPending", "startIntent", "executorExitReceipt"]
            .iter()
            .any(|k| t.get(k).is_some())
        {
            return Err(denied());
        }

        let intent = json!({
        "attempt":self.intent.attempt,"providerId":self.intent.provider_id,"dir":t["run"]["dir"]}
        );

        self.store.update(&self.id, rev(&t)?, now(), |t| {
            t["startIntent"] = intent.clone()
        })?;

        let result = self.effect(RemoteOperation::Start, Value::Null).await?;

        let current = self.owner()?;

        if current["startIntent"] != intent
            || result
                .get("pid")
                .and_then(crate::js_semantics::safe_u64)
                .is_none_or(|p| p == 0)
        {
            return Err(denied());
        }

        Ok(json!({
        "pid":result["pid"]}
        ))
    }

    async fn poll(&mut self) -> Result<Value, BrokerError> {
        let t = self.owner()?;

        let start = &t["startIntent"];

        if crate::js_semantics::safe_u64(&start["attempt"]) != Some(self.intent.attempt)
            || start["providerId"] != self.intent.provider_id
            || start["dir"] != t["run"]["dir"]
        {
            return Err(denied());
        }

        let result = self.effect(RemoteOperation::Read, Value::Null).await?;

        let current = self.owner()?;

        if current["startIntent"] != *start {
            return Err(denied());
        }

        let exit = result.get("exit").and_then(crate::js_semantics::safe_i64);

        if let Some(exit) = exit {
            if result["complete"] != true {
                return Ok(json!({
                "state":"uncertain","exitCode":null}
                ));
            }

            let dir = self.dir.as_ref().ok_or_else(denied)?;

            use base64::{Engine, engine::general_purpose::STANDARD};

            for (field, name) in [("stdoutBase64", "stdout"), ("stderrBase64", "stderr")] {
                if let Some(text) = result[field].as_str() {
                    let bytes = STANDARD.decode(text).map_err(|_| denied())?;

                    if bytes.len() > 4 * 1024 * 1024 || STANDARD.encode(&bytes) != text {
                        return Err(denied());
                    }

                    dir.write(name, &bytes)?;
                }
            }

            let receipt = json!({
            "attempt":self.intent.attempt,"providerId":self.intent.provider_id,"dir":current["run"]["dir"],"startedAt":current["run"]["startedAt"],"exitCode":exit}
            );

            self.store.update(&self.id, rev(&current)?, now(), |t| {
                t["executorExitReceipt"] = receipt
            })?;

            return Ok(json!({
            "state":"exited","exitCode":exit}
            ));
        }

        if !result["alive"].is_boolean() {
            return Err(denied());
        }

        Ok(json!({
        "state":if result["alive"]==true{
        "running"}
        else{
        "uncertain"}
        ,"exitCode":null}
        ))
    }

    fn output(&mut self) -> Result<Value, BrokerError> {
        let t = self.owner()?;

        let receipt = &t["executorExitReceipt"];

        if crate::js_semantics::safe_u64(&receipt["attempt"]) != Some(self.intent.attempt)
            || receipt["providerId"] != self.intent.provider_id
            || receipt["dir"] != t["run"]["dir"]
            || receipt["startedAt"] != t["run"]["startedAt"]
        {
            return Err(denied());
        }

        let dir = self.dir.as_ref().ok_or_else(denied)?;

        use base64::{Engine, engine::general_purpose::STANDARD};

        let out = dir.bytes("stdout", 262144)?.unwrap_or_default();

        let err = dir.bytes("stderr", 262144)?.unwrap_or_default();

        let current = self.owner()?;

        if current["executorExitReceipt"] != *receipt {
            return Err(denied());
        }

        Ok(json!({
        "stdoutBase64":STANDARD.encode(out),"stderrBase64":STANDARD.encode(err)}
        ))
    }

    async fn stop(&mut self, grace: u64) -> Result<Value, BrokerError> {
        let before = self.owner()?;

        let pending = before["stopPending"].clone();
        if self.stop_grant.as_ref() != Some(&(grace, pending.clone())) {
            return Err(denied());
        }

        if crate::js_semantics::safe_u64(&pending["attempt"]) != Some(self.intent.attempt)
            || pending["providerId"] != self.intent.provider_id
            || pending
                .get("graceMs")
                .and_then(crate::js_semantics::safe_u64)
                != Some(grace)
            || before.get("startIntent").is_none()
        {
            return Err(denied());
        }

        if !self.used.insert("stop".into()) {
            return Err(denied());
        }

        let stopped = self
            .effect(
                RemoteOperation::Stop,
                json!({
                "graceMs":grace}
                ),
            )
            .await?;

        let current = self.owner()?;

        if current["stopPending"] != pending {
            return Err(denied());
        }

        let report = self.effect(RemoteOperation::Report, Value::Null).await?;

        let exit = stopped
            .get("code")
            .and_then(crate::js_semantics::safe_i64)
            .ok_or_else(denied)?;

        if report["alive"] != false
            || report.get("exit").and_then(crate::js_semantics::safe_i64) != Some(exit)
            || !stopped["killed"].is_boolean()
        {
            return Err(BrokerError::Effect("remote stop exit is unverified".into()));
        }

        let current = self.owner()?;

        if current["stopPending"] != pending {
            return Err(denied());
        }

        let receipt = json!({
        "attempt":self.intent.attempt,"providerId":self.intent.provider_id,"dir":current["run"]["dir"],"startedAt":current["run"]["startedAt"],"exitCode":exit}
        );

        self.store.update(&self.id, rev(&current)?, now(), |t| {
            t["executorExitReceipt"] = receipt
        })?;

        Ok(json!({
        "code":exit,"killed":stopped["killed"]}
        ))
    }

    async fn transfer(&mut self) -> Result<Value, BrokerError> {
        if !self.used.insert("transfer".into()) {
            return Err(denied());
        }

        let before = self.owner()?;

        if before.get("stopPending").is_some() {
            return Err(denied());
        }

        let receipt = before["executorExitReceipt"].clone();

        if crate::js_semantics::safe_u64(&receipt["attempt"]) != Some(self.intent.attempt)
            || receipt["providerId"] != self.intent.provider_id
            || receipt["dir"] != before["run"]["dir"]
            || receipt["startedAt"] != before["run"]["startedAt"]
        {
            return Err(denied());
        }

        if receipt["exitCode"].as_f64() != Some(0.0) {
            let facts = self.effect(RemoteOperation::Preflight, Value::Null).await?;

            if facts["noWork"] == true && facts["baseSha"] == self.intent.base_sha {
                let current = self.owner()?;

                if current.get("stopPending").is_some() || current["executorExitReceipt"] != receipt
                {
                    return Err(denied());
                }

                let mut receipt = receipt;

                receipt.as_object_mut().map(|o| o.remove("exitCode"));

                receipt["exitCode"] = before["executorExitReceipt"]["exitCode"].clone();

                self.store.update(&self.id, rev(&current)?, now(), |t| {
                    t["remoteTransferNoWork"] = receipt
                })?;

                return Ok(json!({
                "transferred":false}
                ));
            }

            if facts["committedWork"] != true {
                return Err(BrokerError::Effect(
                    "remote no-work preflight is unverified".into(),
                ));
            }
        }

        let current = self.owner()?;

        if current.get("stopPending").is_some() || current["executorExitReceipt"] != receipt {
            return Err(denied());
        }

        let result = self.effect(RemoteOperation::Transfer, Value::Null).await?;

        let current = self.owner()?;

        if current.get("stopPending").is_some() || current["executorExitReceipt"] != receipt {
            return Err(denied());
        }

        if !result["transferred"].is_boolean() {
            return Err(denied());
        }

        Ok(result)
    }
}

impl<H: RemoteHost> CapabilityEffect for NativeRemote<H> {
    fn owns_lifecycle(&self, method: &str, plugin_id: &str, scopes: &[String]) -> bool {
        method.starts_with("capability.hosts.")
            && plugin_id == self.intent.provider_id
            && scopes.iter().any(|s| s == "owned-remote-pipe")
    }

    async fn call(&mut self, method: &str, p: Value) -> Result<Value, BrokerError> {
        self.answer(method, &p).await
    }
}
