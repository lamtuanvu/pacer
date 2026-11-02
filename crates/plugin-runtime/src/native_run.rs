//! Durable local executor effects. All paths, images and launch context are host-issued.
pub mod directory;

mod state;

use crate::{AuthorityError, BrokerError, CapabilityEffect, native_process::Image};

use directory::RunDirectory;

use pacer_store::TaskStore;

use serde_json::{Value, json};

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct RunLaunchFile {
    pub name: String,
    pub content: String,
    pub mode: u32,
}

#[derive(Clone)]
pub struct RunLaunch {
    pub home: String,
    pub umask: Option<String>,
    pub keep_color: Vec<String>,
    pub argv: Vec<String>,
    pub executable: String,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub stdin: Option<String>,
    pub session: Option<String>,
    pub files: Vec<RunLaunchFile>,
}

pub struct NativeRun {
    store: TaskStore,
    home: PathBuf,
    id: String,
    provider: String,
    executor: String,
    attempt: u64,
    launch: RunLaunch,
    image: Option<Image>,
    cwd: Option<Image>,
    dir: Option<RunDirectory>,
    observed: Option<Value>,
    used: HashSet<String>,
    deadline: Instant,
    child: Option<tokio::process::Child>,
    resumed: bool,
    stop_grant: Option<(u64, Value, Option<Value>, Value)>,
    inspection_rev: Option<Value>,
    completion_report: Option<Value>,
    session_launcher: Option<(Image, Vec<String>)>,
}

pub fn denied() -> BrokerError {
    AuthorityError::Denied("executor run owner or source changed".into()).into()
}

pub fn rev(t: &Value) -> Result<i64, BrokerError> {
    t.get("rev")
        .and_then(crate::js_semantics::safe_i64)
        .filter(|n| *n > 0)
        .ok_or_else(denied)
}

pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64 / 1000.0)
}

fn base(t: &Value, provider: &str, executor: &str, attempt: u64) -> Result<(), BrokerError> {
    if t["state"] != "running"
        || t["executorProvider"] != provider
        || t["executor"] != executor
        || t["attempts"]
            .as_array()
            .is_none_or(|a| a.len() as u64 + 1 != attempt)
    {
        return Err(denied());
    }

    Ok(())
}

impl NativeRun {
    pub fn issue(
        home: &Path,
        id: &str,
        provider: &str,
        executor: &str,
        attempt: u64,
        launch: RunLaunch,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        if !pacer_store::is_task_id(id)
            || attempt == 0
            || attempt > 9_007_199_254_740_991
            || !Path::new(&launch.home).is_absolute()
            || launch.argv.is_empty()
            || launch.argv.len() > 32
            || launch.argv.iter().any(|s| {
                s.is_empty() || s.contains('\0') || crate::js_semantics::utf16_len(s) > 4096
            })
            || launch.stdin.as_ref().is_some_and(|s| s.len() > 262144)
            || launch.session.as_ref().is_some_and(|s| s != "interactive")
            || launch.env.iter().any(|(k, v)| {
                k.starts_with("PACER_KEY_")
                    || k.is_empty()
                    || k.contains('=')
                    || k.contains('\0')
                    || v.contains('\0')
            })
        {
            return Err(BrokerError::Invalid("executor launch"));
        }

        let image = Image::pin(&launch.executable, true)?;

        let cwd = Image::pin(&launch.cwd, false)?;

        if image.canonical != Path::new(&launch.executable)
            || cwd.canonical != Path::new(&launch.cwd)
        {
            return Err(denied());
        }

        let mut store = TaskStore::open(home)?;

        let task = store.read(id)?.ok_or_else(denied)?;

        base(&task, provider, executor, attempt)?;

        Ok(Self {
            store,
            home: home.into(),
            id: id.into(),
            provider: provider.into(),
            executor: executor.into(),
            attempt,
            launch,
            image: Some(image),
            cwd: Some(cwd),
            dir: None,
            observed: None,
            used: HashSet::new(),
            deadline,
            child: None,
            resumed: false,
            stop_grant: None,
            inspection_rev: None,
            completion_report: None,
            session_launcher: None,
        })
    }

    pub fn resume(
        home: &Path,
        id: &str,
        provider: &str,
        executor: &str,
        attempt: u64,
        launch: RunLaunch,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        let mut store = TaskStore::open(home)?;
        let task = store.read(id)?.ok_or_else(denied)?;
        base(&task, provider, executor, attempt)?;
        let mut owner = Self {
            store,
            home: home.into(),
            id: id.into(),
            provider: provider.into(),
            executor: executor.into(),
            attempt,
            launch,
            image: None,
            cwd: None,
            dir: None,
            observed: None,
            used: HashSet::new(),
            deadline,
            child: None,
            resumed: true,
            stop_grant: None,
            inspection_rev: None,
            completion_report: None,
            session_launcher: None,
        };
        let dir = RunDirectory::existing(home, id, attempt)?;
        if task["run"]["dir"] != json!(dir.path)
            || task["run"]["attempt"].as_f64() != Some(attempt as f64)
            || task["run"].get("host").is_some()
        {
            return Err(denied());
        }
        owner.dir = Some(dir);
        owner.observed = Some(task["run"].clone());
        owner.resumed = true;
        owner.inspection_rev = Some(task["rev"].clone());
        owner.owner()?;
        Ok(owner)
    }
    /// Issue an exact stop independently of observation; plugins cannot upgrade a read grant.
    pub fn with_stop_grant(mut self, grace_ms: u64) -> Result<Self, BrokerError> {
        if grace_ms > 25000 {
            return Err(BrokerError::Invalid("graceMs"));
        }
        let task = self.owner()?;
        let state = state::read(self.dir.as_ref().ok_or_else(denied)?)?;
        let pending = task.get("stopPending").cloned();
        if let Some(p) = &pending
            && (p["attempt"].as_f64() != Some(self.attempt as f64)
                || p["providerId"] != self.provider
                || p["graceMs"].as_f64() != Some(grace_ms as f64))
        {
            return Err(denied());
        }
        self.stop_grant = Some((grace_ms, task["rev"].clone(), pending, state["pid"].clone()));
        Ok(self)
    }
    /// Host-selected reentry command for the existing `_session` owner during coexistence.
    /// Its argv is private, immutable, and never received from plugin RPC.
    pub fn with_session_launcher(
        mut self,
        executable: &str,
        args: Vec<String>,
    ) -> Result<Self, BrokerError> {
        self.session_launcher = Some((Image::pin(executable, true)?, args));

        Ok(self)
    }

    fn active(&self) -> Result<(), BrokerError> {
        if Instant::now() >= self.deadline {
            Err(BrokerError::Timeout)
        } else {
            Ok(())
        }
    }

    pub async fn answer(&mut self, method: &str, p: &Value) -> Result<Value, BrokerError> {
        self.active()?;

        let start = method == "capability.process.startRun";

        let allowed = if start {
            vec!["task", "attempt", "runDir"]
        } else if method == "capability.process.stopRun" {
            vec!["taskId", "attempt", "graceMs"]
        } else {
            vec!["taskId", "attempt"]
        };

        if p.as_object()
            .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
            || p.get("attempt").and_then(crate::js_semantics::safe_u64) != Some(self.attempt)
            || if start {
                p.pointer("/task/id").and_then(Value::as_str) != Some(&self.id)
                    || p["runDir"] != 1
                    || p["task"].as_object().is_none_or(|o| o.len() != 2)
            } else {
                p["taskId"] != self.id
            }
        {
            return Err(denied());
        }

        match method {
            "capability.process.claimRun" if !self.resumed => self.claim(),
            "capability.process.startRun" if !self.resumed => self.start(p),
            "capability.process.inspectRun" => {
                if !self.used.insert(method.into()) {
                    return Err(denied());
                }

                if let Some(revision) = &self.inspection_rev
                    && self.store.read(&self.id)?.as_ref().map(|t| &t["rev"]) != Some(revision)
                {
                    return Err(denied());
                }
                let s = self.poll()?;
                if let Some(revision) = &self.inspection_rev
                    && self.store.read(&self.id)?.as_ref().map(|t| &t["rev"]) != Some(revision)
                {
                    return Err(denied());
                }
                Ok(json!({
                "state":s["state"]}
                ))
            }

            "capability.process.pollRun" => self.poll(),
            "capability.process.readRunOutput" => self.output(),
            "capability.process.stopRun" => {
                let grace = p
                    .get("graceMs")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|n| *n <= 25000)
                    .ok_or(BrokerError::Invalid("graceMs"))?;

                self.validate_stop(grace)?;
                if !self.used.insert(method.into()) {
                    return Err(denied());
                }
                self.stop(grace).await
            }

            "capability.process.completeReportedRun" => self.complete().await,
            _ => Err(BrokerError::Invalid("executor method")),
        }
    }

    fn claim(&mut self) -> Result<Value, BrokerError> {
        let id = self.id.clone();
        let home = self.home.clone();
        let mut context = ClaimContext {
            home: &home,
            id: &id,
            provider: &self.provider,
            executor: &self.executor,
            attempt: self.attempt,
            launch: &self.launch,
            image: self.image.as_ref().ok_or_else(denied)?,
            cwd: self.cwd.as_ref().ok_or_else(denied)?,
            dir: &mut self.dir,
            observed: &mut self.observed,
        };
        self.store
            .with_task_lock(&id, |locked| context.claim(locked))
    }
    fn owner(&mut self) -> Result<Value, BrokerError> {
        self.active()?;

        let t = self.store.read(&self.id)?.ok_or_else(denied)?;

        self.check_owner(&t)?;

        Ok(t)
    }

    fn check_owner(&self, t: &Value) -> Result<(), BrokerError> {
        base(t, &self.provider, &self.executor, self.attempt)?;

        let expected = self.observed.as_ref().ok_or_else(denied)?;

        for key in [
            "dir",
            "attempt",
            "executor",
            "startedAt",
            "workdir",
            "session",
        ] {
            if !crate::js_semantics::json_option_equal(t["run"].get(key), expected.get(key)) {
                return Err(denied());
            }
        }

        if t["run"].get("host").is_some()
            || t.get("startIntent").is_some_and(|i| {
                crate::js_semantics::safe_u64(&i["attempt"]) == Some(self.attempt)
                    && (i["providerId"] != self.provider || i["dir"] != expected["dir"])
            })
        {
            return Err(denied());
        }

        self.dir.as_ref().ok_or_else(denied)?.check()
    }

    fn start(&mut self, p: &Value) -> Result<Value, BrokerError> {
        if !self.used.insert("start".into()) {
            return Err(denied());
        }

        let home = self.home.clone();

        let id = self.id.clone();

        let expected = self.observed.clone().ok_or_else(denied)?;

        let dir = self.dir.as_ref().ok_or_else(denied)?;

        let launch = &self.launch;

        let image = self.image.as_ref().ok_or_else(denied)?;
        let cwd = self.cwd.as_ref().ok_or_else(denied)?;

        let provider = &self.provider;

        let executor = &self.executor;

        let attempt = self.attempt;

        let session_launcher = &self.session_launcher;

        let context = StartContext {
            home: &home,
            expected: &expected,
            dir,
            launch,
            image,
            cwd,
            provider,
            executor,
            attempt,
            session_launcher,
            p,
        };
        let child = self
            .store
            .with_task_lock(&id, |locked| context.spawn(locked))?;

        let pid = child.id().ok_or_else(denied)?;

        self.child = Some(child);

        Ok(json!({
        "pid":pid}
        ))
    }

    fn poll(&mut self) -> Result<Value, BrokerError> {
        let before = self.owner()?;

        let dir = self.dir.as_ref().ok_or_else(denied)?;

        let mut result = state::read(dir)?;
        if self
            .completion_report
            .as_ref()
            .is_some_and(|r| result["report"] != *r)
        {
            return Err(denied());
        }

        let after = self.owner()?;

        if before["run"]["startedAt"] != after["run"]["startedAt"] {
            return Err(denied());
        }

        result["stopPending"] = json!(after.get("stopPending").is_some());

        if let Some(child) = self.child.as_mut() {
            let _ = child.try_wait();
        }

        Ok(result)
    }

    fn output(&mut self) -> Result<Value, BrokerError> {
        let before = self.poll()?;

        if before["state"] != "exited" {
            return Err(denied());
        }

        let dir = self.dir.as_ref().ok_or_else(denied)?;

        use base64::Engine;

        let out = dir.bytes("stdout", 262144)?.unwrap_or_default();

        let err = dir.bytes("stderr", 262144)?.unwrap_or_default();

        let after = self.poll()?;

        for key in ["state", "exitCode", "stdoutBytes", "stderrBytes"] {
            if after[key] != before[key] {
                return Err(denied());
            }
        }

        Ok(json!({
        "stdoutBase64":base64::engine::general_purpose::STANDARD.encode(out),"stderrBase64":base64::engine::general_purpose::STANDARD.encode(err)}
        ))
    }

    fn validate_stop(&mut self, grace: u64) -> Result<(), BrokerError> {
        let (issued, revision, pending, pid) = self.stop_grant.clone().ok_or_else(denied)?;
        let task = self.owner()?;
        if grace != issued
            || if pending.is_some() {
                task.get("stopPending") != pending.as_ref()
            } else {
                task["rev"] != revision
            }
            || state::read(self.dir.as_ref().ok_or_else(denied)?)?["pid"] != pid
        {
            return Err(denied());
        }
        Ok(())
    }
    async fn stop(&mut self, grace: u64) -> Result<Value, BrokerError> {
        let t = self.owner()?;

        let identity = t["run"].clone();

        let pending = t.get("stopPending").cloned();

        let end = (Instant::now() + Duration::from_millis(grace)).min(self.deadline);

        let initial = self.poll()?;

        if initial["state"] == "exited" {
            return Ok(json!({
            "code":initial["exitCode"],"killed":false}
            ));
        }

        while !self
            .dir
            .as_ref()
            .ok_or_else(denied)?
            .path
            .join("child")
            .exists()
            && Instant::now() < end
        {
            let s = self.poll()?;

            if s["state"] == "exited" {
                return Ok(json!({
                "code":s["exitCode"],"killed":false}
                ));
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        for signal in [
            nix::sys::signal::Signal::SIGTERM,
            nix::sys::signal::Signal::SIGKILL,
        ] {
            if self.stop_grant.is_some() {
                self.validate_stop(grace)?;
            }
            let current = self.owner()?;

            if current["run"] != identity || current.get("stopPending") != pending.as_ref() {
                return Err(denied());
            }

            let s = self.poll()?;

            if s["state"] == "exited" {
                return Ok(json!({
                "code":s["exitCode"],"killed":false}
                ));
            }

            if s["state"] != "running" {
                return Err(BrokerError::Effect(
                    "detached stop has no verified completion receipt".into(),
                ));
            }

            let pid = s
                .get("pid")
                .and_then(crate::js_semantics::safe_i64)
                .and_then(|p| i32::try_from(p).ok())
                .filter(|p| *p > 1)
                .ok_or_else(denied)?;

            let id = self.id.clone();
            let dir = self.dir.as_ref().ok_or_else(denied)?;
            self.store.with_task_lock(&id, |locked| {
                let latest = locked.read()?;
                if latest["rev"] != current["rev"] || latest["run"] != identity {
                    return Err(denied());
                }
                dir.check()?;
                let observed = state::read(dir)?;
                if observed["state"] != "running"
                    || self
                        .completion_report
                        .as_ref()
                        .is_some_and(|r| observed["report"] != *r)
                {
                    return Err(denied());
                }
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(-pid), signal);
                Ok::<_, BrokerError>(())
            })?;
            let wait = if signal == nix::sys::signal::Signal::SIGTERM {
                end
            } else {
                (Instant::now() + Duration::from_millis(100)).min(self.deadline)
            };

            loop {
                let s = self.poll()?;

                if s["state"] == "exited" {
                    return Ok(json!({
                    "code":s["exitCode"],"killed":false}
                    ));
                }

                if Instant::now() >= wait {
                    break;
                }

                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }

        Err(BrokerError::Effect(
            "detached stop has no verified completion receipt".into(),
        ))
    }

    async fn complete(&mut self) -> Result<Value, BrokerError> {
        let before = self.owner()?;

        if before.get("stopPending").is_some()
            || before["run"]["session"] != "interactive"
            || before["startIntent"]["providerId"] != self.provider
            || before["startIntent"]["attempt"].as_f64() != Some(self.attempt as f64)
            || before["startIntent"]["dir"] != before["run"]["dir"]
        {
            return Err(denied());
        }

        let report = self.poll()?["report"].clone();

        if !["done", "failed"].contains(&report["status"].as_str().unwrap_or_default())
            || report["summary"]
                .as_str()
                .is_none_or(|s| s.is_empty() || crate::js_semantics::utf16_len(s) > 16000)
        {
            return Err(denied());
        }

        if !self.used.insert("complete".into()) {
            return Err(denied());
        }

        self.completion_report = Some(report.clone());
        let stopped = self.stop(5000).await?;

        let current = self.owner()?;

        if self.poll()?["report"] != report || current.get("stopPending").is_some() {
            return Err(denied());
        }

        let receipt = json!({
        "attempt":self.attempt,"providerId":self.provider,"dir":current["run"]["dir"],"startedAt":current["run"]["startedAt"],"status":report["status"],"summary":report["summary"],"at":report["at"],"exitCode":stopped["code"]}
        );

        self.store.update(&self.id, rev(&current)?, now(), |t| {
            t["executorReportReceipt"] = receipt
        })?;

        Ok(json!({
        "status":report["status"],"summary":report["summary"],"at":report["at"],"exitCode":stopped["code"]}
        ))
    }
}

struct ClaimContext<'a> {
    home: &'a Path,
    id: &'a str,
    provider: &'a str,
    executor: &'a str,
    attempt: u64,
    launch: &'a RunLaunch,
    image: &'a Image,
    cwd: &'a Image,
    dir: &'a mut Option<RunDirectory>,
    observed: &'a mut Option<Value>,
}
impl ClaimContext<'_> {
    fn claim(&mut self, locked: &mut pacer_store::LockedTask<'_>) -> Result<Value, BrokerError> {
        let home = self.home;
        let id = self.id;

        let mut t = locked.read()?;
        base(&t, self.provider, self.executor, self.attempt)?;
        if t.get("stopPending").is_some()
            || t.get("startIntent").is_some()
            || t.get("worktreeIntent").is_some_and(|i| {
                i["providerId"] != self.provider
                    || crate::js_semantics::safe_u64(&i["attempt"]) != Some(self.attempt)
                    || i["workdir"] != self.launch.cwd
            })
        {
            return Err(denied());
        }

        self.image.check()?;
        self.cwd.check()?;
        let path = home.join("runs").join(id).join(self.attempt.to_string());

        if t.get("run").is_none() {
            let isolated = std::fs::canonicalize(t["brief"]["repo"].as_str().ok_or_else(denied)?)
                .map_err(|_| denied())?
                != self.cwd.canonical;

            if isolated && t.get("worktreeIntent").is_none()
                || !isolated && t.get("worktreeIntent").is_some()
            {
                return Err(denied());
            }

            let mut expected = json!({
            "attempt":self.attempt,"providerId":self.provider,"executor":self.executor,"workdir":self.launch.cwd,"dir":path}
            );
            if let Some(session) = &self.launch.session {
                expected["session"] = json!(session);
            }

            let recover = t.get("runClaim").is_some();
            if recover && t["runClaim"] != expected {
                return Err(denied());
            }
            if !recover {
                if path.symlink_metadata().is_ok() {
                    return Err(denied());
                }
                t = locked.update(rev(&t)?, now(), |t| t["runClaim"] = expected.clone())?;
            }

            let dir = RunDirectory::claim(home, id, self.attempt, recover)?;
            let mut run = json!({
            "dir":path,"attempt":self.attempt,"executor":self.executor,"startedAt":now(),"mode":if isolated{
            "new"}
            else{
            "current"}
            ,"workdir":self.launch.cwd,"logFile":path.join("stdout")}
            );
            if let Some(session) = &self.launch.session {
                run["session"] = json!(session);
            }

            t = locked.update(rev(&t)?, now(), |t| {
                t["run"] = run;
                t.as_object_mut().map(|o| o.remove("runClaim"));
                if isolated {
                    t["worktree"] = json!(self.launch.cwd);
                }
            })?;
            *self.dir = Some(dir);
        }

        let run = &t["run"];
        if run["dir"] != json!(path)
            || crate::js_semantics::safe_u64(&run["attempt"]) != Some(self.attempt)
            || run["executor"] != self.executor
            || run["workdir"] != self.launch.cwd
            || run.get("host").is_some()
            || run.get("session").and_then(Value::as_str) != self.launch.session.as_deref()
            || t.get("runClaim").is_some()
        {
            return Err(denied());
        }

        if self.dir.is_none() {
            *self.dir = Some(RunDirectory::existing(home, id, self.attempt)?);
        }
        let dir = self.dir.as_ref().ok_or_else(denied)?;
        dir.check()?;
        if std::fs::read_dir(&path)
            .map_err(|_| denied())?
            .next()
            .is_some()
        {
            return Err(denied());
        }

        *self.observed = Some(run.clone());
        Ok(json!({
        "task":{
        "id":id,"rev":t["rev"]}
        ,"attempt":self.attempt,"runDir":1,"dir":path,"workdir":run["workdir"],"startedAt":run["startedAt"],"logFile":run["logFile"]}
        ))
    }
}
fn launch_argv(launch: &RunLaunch) -> Vec<String> {
    let mut argv = vec![launch.executable.clone()];
    argv.extend_from_slice(&launch.argv[1..]);
    if let Some(mask) = &launch.umask
        && (3..=4).contains(&mask.len())
        && mask.bytes().all(|b| (b'0'..=b'7').contains(&b))
    {
        let mut prefix = vec![
            "/bin/sh".into(),
            "-c".into(),
            "umask \"$1\" && shift && exec \"$@\"".into(),
            "pacer-umask".into(),
            mask.clone(),
        ];
        prefix.extend(argv);
        return prefix;
    }
    argv
}
struct StartContext<'a> {
    home: &'a Path,
    expected: &'a Value,
    dir: &'a RunDirectory,
    launch: &'a RunLaunch,
    image: &'a Image,
    cwd: &'a Image,
    provider: &'a str,
    executor: &'a str,
    attempt: u64,
    session_launcher: &'a Option<(Image, Vec<String>)>,
    p: &'a Value,
}
impl StartContext<'_> {
    fn spawn(
        &self,
        locked: &mut pacer_store::LockedTask<'_>,
    ) -> Result<tokio::process::Child, BrokerError> {
        let home = self.home;
        let expected = self.expected;
        let dir = self.dir;
        let launch = self.launch;
        let image = self.image;
        let cwd = self.cwd;
        let provider = self.provider;
        let executor = self.executor;
        let attempt = self.attempt;
        let session_launcher = self.session_launcher;
        let p = self.p;

        let t = locked.read()?;
        base(&t, provider, executor, attempt)?;
        if &t["run"] != expected
            || t.get("stopPending").is_some()
            || t.get("startIntent").is_some()
            || t["rev"].as_f64() != p["task"]["rev"].as_f64()
        {
            return Err(denied());
        }
        dir.check()?;
        image.check()?;
        cwd.check()?;

        if launch.session.is_some() && session_launcher.is_none() {
            return Err(BrokerError::Effect(
                "interactive session launcher was not issued".into(),
            ));
        }

        locked.update(rev(&t)?, now(), |t| {
            t["startIntent"] = json!({
            "attempt":attempt,"providerId":provider,"dir":dir.path}
            )
        })?;

        let mut names = HashSet::new();
        for file in &launch.files {
            let (mode, max, interactive) = match file.name.as_str() {
                "report-hook.sh" => (0o700, 16384, true),
                "claude-settings.json" => (0o600, 16384, true),
                "strict-claude-settings.json" => (0o600, 16384, false),
                "prompt.md" => (0o600, 8 * 1024 * 1024, true),
                _ => return Err(denied()),
            };
            if !names.insert(&file.name)
                || file.mode != mode
                || file.content.len() > max
                || interactive && launch.session.as_deref() != Some("interactive")
            {
                return Err(denied());
            }
        }

        for file in &launch.files {
            dir.publish(&file.name, file.content.as_bytes(), file.mode)?;
        }

        dir.publish("run.sh", include_bytes!("native_run/wrapper.sh"), 0o700)?;

        if let Some(stdin) = &launch.stdin {
            dir.write("stdin", stdin.as_bytes())?;
        }

        let mut env = launch.env.clone();
        env.entry("PATH".into()).or_insert("/usr/bin:/bin".into());
        env.insert("PACER_HOME".into(), home.to_string_lossy().into_owned());
        env.insert("HOME".into(), launch.home.clone());

        let mut command = if let Some((image, args)) = session_launcher
            .as_ref()
            .filter(|_| launch.session.is_some())
        {
            image.check()?;
            let token = uuid::Uuid::new_v4().simple().to_string()
                + &uuid::Uuid::new_v4().simple().to_string();
            dir.write(
                "interactive.json",
                serde_json::to_vec(&json!({
                "reportToken":token}
                ))
                .map_err(|_| denied())?
                .as_slice(),
            )?;
            dir.write("session.json",serde_json::to_vec(&json!({
"interactive":true,"argv":launch_argv(launch),"cwd":launch.cwd,"pacerHome":home,"capBytes":8*1024*1024,"keepColor":launch.keep_color}
)).map_err(|_|denied())?.as_slice())?;
            env.insert("PACER_REPORT_TOKEN".into(), token);
            let mut c = tokio::process::Command::new(&image.canonical);
            c.args(args).arg(&dir.path);
            c
        } else {
            let mut c = tokio::process::Command::new("/bin/sh");
            c.arg(dir.path.join("run.sh"))
                .arg(&dir.path)
                .args(launch_argv(launch));
            c
        };

        image.check()?;
        cwd.check()?;
        dir.check()?;
        command
            .current_dir(&cwd.canonical)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(false);
        let mut child = command.spawn().map_err(|_| {
            BrokerError::Effect("detached wrapper launch uncertain; inspect run directory".into())
        })?;
        let pid = child.id().ok_or_else(denied)?;
        if let Err(error) = dir.write("pid", pid.to_string().as_bytes()) {
            // The fixed wrapper atomically publishes this same PID. It may win
            // between the parent's write snapshot and rename; accept only that
            // exact value under the pinned directory, never overwrite a rival.
            let recorded = dir.bytes("pid", 64)?;
            if recorded
                .as_deref()
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .map(crate::js_semantics::trim)
                != Some(pid.to_string().as_str())
            {
                if let Ok(pid) = i32::try_from(pid) {
                    let _ = nix::sys::signal::kill(
                        nix::unistd::Pid::from_raw(-pid),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                }
                let _ = child.start_kill();
                return Err(error);
            }
        }
        let current = locked.read()?;
        locked.update(rev(&current)?, now(), |t| t["childPid"] = json!(pid))?;
        Ok(child)
    }
}
impl CapabilityEffect for NativeRun {
    fn owns_lifecycle(&self, method: &str, plugin_id: &str, scopes: &[String]) -> bool {
        method.starts_with("capability.process.")
            && plugin_id == self.provider
            && (!matches!(
                method,
                "capability.process.startRun" | "capability.process.claimRun"
            ) || self.launch.argv.first().is_some_and(|a| scopes.contains(a)))
    }

    async fn call(&mut self, method: &str, p: Value) -> Result<Value, BrokerError> {
        self.answer(method, &p).await
    }
}
