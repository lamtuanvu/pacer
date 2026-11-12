//! Task-owned Orca capability dispatch. Sessions are host objects, never plugin-provided handles.
use crate::{AuthorityError, BrokerError, CapabilityEffect};
use pacer_store::TaskStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, path::Path};
pub const ORCA_PROVIDER: &str = "pacer-exec-orca";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaAttemptResource {
    pub task_id: String,
    pub attempt: u64,
    pub provider_id: String,
    pub executor: String,
    pub session: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaLiveResource {
    pub task_id: String,
    pub attempt: u64,
    pub provider_id: String,
    pub worker: String,
    pub terminal: String,
    pub incarnation: Option<String>,
    pub action: String,
    pub why: Option<String>,
}
fn denied() -> BrokerError {
    AuthorityError::Denied("Orca attempt or live worker changed".into()).into()
}
fn valid_params(action: &str, params: &Value) -> bool {
    let Some(object) = params.as_object() else {
        return false;
    };
    let extra: &[&str] = match action {
        "abandon" => &["reason"],
        "settle" => &["settled"],
        "finish" => &[
            "code",
            "timedOut",
            "settled",
            "summary",
            "tail",
            "launchBroken",
            "keepAlive",
        ],
        _ => &[],
    };
    if object
        .keys()
        .any(|key| key != "taskId" && key != "attempt" && !extra.contains(&key.as_str()))
    {
        return false;
    }
    let bounded = |key: &str, max: usize, required: bool, min: usize| match object.get(key) {
        None => !required,
        Some(Value::String(s)) => (min..=max).contains(&crate::js_semantics::codepoint_len(s)),
        _ => false,
    };
    match action {
        "abandon" => bounded("reason", 4096, true, 1),
        "settle" => object.get("settled").is_some_and(Value::is_boolean),
        "finish" => {
            object
                .get("code")
                .and_then(crate::js_semantics::safe_i64)
                .is_some()
                && ["timedOut", "settled", "keepAlive"]
                    .iter()
                    .all(|key| object.get(*key).is_some_and(Value::is_boolean))
                && bounded("summary", 65536, true, 0)
                && bounded("tail", 65536, false, 0)
                && bounded("launchBroken", 4096, false, 0)
        }
        _ => true,
    }
}
pub trait OrcaSessionOwner {
    fn session_id(&self) -> &str;
    fn task_id(&self) -> &str;
    fn attempt(&self) -> u64;
    fn executor(&self) -> &str;
    fn invoke(
        &mut self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
}
pub struct NativeOrca<S> {
    store: TaskStore,
    plugin_id: String,
    grant: OrcaAttemptResource,
    session: S,
}
impl<S: OrcaSessionOwner> NativeOrca<S> {
    pub fn new(
        home: &Path,
        plugin_id: &str,
        grant: OrcaAttemptResource,
        session: S,
    ) -> Result<Self, BrokerError> {
        Ok(Self {
            store: TaskStore::open(home).map_err(|_| denied())?,
            plugin_id: plugin_id.into(),
            grant,
            session,
        })
    }
    fn owner(&mut self, params: &Value) -> Result<(), BrokerError> {
        let grant = &self.grant;
        if self.plugin_id != ORCA_PROVIDER
            || grant.provider_id != ORCA_PROVIDER
            || params["taskId"] != grant.task_id
            || params
                .get("attempt")
                .and_then(crate::js_semantics::safe_u64)
                != Some(grant.attempt)
            || self.session.session_id() != grant.session
            || self.session.task_id() != grant.task_id
            || self.session.attempt() != grant.attempt
            || self.session.executor() != grant.executor
        {
            return Err(denied());
        }
        let task = self
            .store
            .read(&grant.task_id)
            .map_err(|_| denied())?
            .ok_or_else(denied)?;
        if task["attempts"]
            .as_array()
            .is_none_or(|a| a.len() as u64 + 1 != grant.attempt)
        {
            return Err(denied());
        }
        Ok(())
    }
}
impl<S: OrcaSessionOwner> CapabilityEffect for NativeOrca<S> {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        let action = method
            .strip_prefix("capability.orca.")
            .filter(|m| {
                [
                    "liveAnswer",
                    "prepare",
                    "place",
                    "terminal",
                    "abandon",
                    "start",
                    "lookup",
                    "adopt",
                    "unstarted",
                    "wait",
                    "settle",
                    "finish",
                ]
                .contains(m)
            })
            .ok_or_else(denied)?;
        if !valid_params(action, &params) {
            return Err(denied());
        }
        self.owner(&params)?;
        self.session.invoke(action, params).await
    }
}
pub trait OrcaLiveControl {
    fn release(
        &mut self,
        worker: &str,
        terminal: &str,
        incarnation: Option<&str>,
        why: &str,
    ) -> impl Future<Output = Result<(), BrokerError>>;
    fn problem(
        &mut self,
        worker: &str,
        terminal: &str,
        incarnation: Option<&str>,
    ) -> impl Future<Output = Result<Option<String>, BrokerError>>;
}
pub struct NativeOrcaLive<C> {
    store: TaskStore,
    plugin_id: String,
    grant: OrcaLiveResource,
    control: C,
    used: bool,
}
impl<C: OrcaLiveControl> NativeOrcaLive<C> {
    pub fn new(
        home: &Path,
        plugin_id: &str,
        grant: OrcaLiveResource,
        control: C,
    ) -> Result<Self, BrokerError> {
        Ok(Self {
            store: TaskStore::open(home).map_err(|_| denied())?,
            plugin_id: plugin_id.into(),
            grant,
            control,
            used: false,
        })
    }
}
impl<C: OrcaLiveControl> CapabilityEffect for NativeOrcaLive<C> {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        let action = match method {
            "capability.orca.stop" => "stop",
            "capability.orca.sessionState" => "inspect",
            _ => return Err(denied()),
        };
        let g = &self.grant;
        if !valid_params(action, &params)
            || self.used
            || self.plugin_id != ORCA_PROVIDER
            || g.provider_id != ORCA_PROVIDER
            || g.action != action
            || params["taskId"] != g.task_id
            || params
                .get("attempt")
                .and_then(crate::js_semantics::safe_u64)
                != Some(g.attempt)
        {
            return Err(denied());
        }
        self.used = true;
        let task = self
            .store
            .read(&g.task_id)
            .map_err(|_| denied())?
            .ok_or_else(denied)?;
        if task.pointer("/live/backend").and_then(Value::as_str) != Some("orca")
            || task.pointer("/live/worker").and_then(Value::as_str) != Some(&g.worker)
            || task.pointer("/live/terminal").and_then(Value::as_str) != Some(&g.terminal)
            || task.pointer("/live/incarnation").and_then(Value::as_str) != g.incarnation.as_deref()
        {
            return Err(denied());
        }
        if action == "stop" {
            self.control
                .release(
                    &g.worker,
                    &g.terminal,
                    g.incarnation.as_deref(),
                    g.why.as_deref().unwrap_or("the task was stopped"),
                )
                .await?;
            let task = self.store.read(&g.task_id).map_err(|_| denied())?;
            return Ok(
                json!({"code":0,"killed":task.as_ref().is_none_or(|t|t.get("live").is_none_or(Value::is_null))}),
            );
        }
        let problem = self
            .control
            .problem(&g.worker, &g.terminal, g.incarnation.as_deref())
            .await?;
        let state = match problem.as_deref() {
            None => "running",
            Some(p) if p.starts_with("the worker is ") || p == "the terminal is gone" => "exited",
            _ => "uncertain",
        };
        Ok(json!({"state":state,"handle":g.terminal}))
    }
}

/// Native read-only Orca status. The image is selected and pinned by the host.
pub struct NativeOrcaStatus {
    process: crate::NativeProcess,
    environment: std::collections::HashMap<String, String>,
    deadline: std::time::Instant,
}
impl NativeOrcaStatus {
    pub fn prepare(
        executable: &str,
        mut environment: std::collections::HashMap<String, String>,
        deadline: std::time::Instant,
    ) -> Result<Self, BrokerError> {
        let named = environment.get("ORCA_AGENT_SESSION_ID_ENV").cloned();
        environment.retain(|key, _| {
            ![
                "ORCA_AGENT_SESSION_ID",
                "ORCA_AGENT_SESSION_ID_ENV",
                "ORCA_TERMINAL_HANDLE",
                "ORCA_PANE_KEY",
                "ORCA_TAB_ID",
                "ORCA_WORKTREE_ID",
                "ORCA_AGENT_LAUNCH_TOKEN",
            ]
            .contains(&key.as_str())
                && named.as_ref() != Some(key)
                && !key.starts_with("ORCA_AGENT_HOOK_")
                && !key.starts_with("ORCA_SESSION_")
        });
        let command = crate::CommandResource {
            argv: vec!["orca".into(), "status".into(), "--json".into()],
            timeout_ms: 15000,
            env: Some(environment.clone()),
            ..Default::default()
        };
        let selected = std::collections::HashMap::from([("orca".into(), executable.into())]);
        Ok(Self {
            process: crate::NativeProcess::prepare(&[command], &selected, &environment)?,
            environment,
            deadline,
        })
    }
}
impl CapabilityEffect for NativeOrcaStatus {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        if method != "capability.orca.status" || params.as_object().is_none_or(|o| !o.is_empty()) {
            return Err(denied());
        }
        let result=self.process.spawn(&json!({"argv":["orca","status","--json"],"timeoutMs":15000,"env":self.environment}),self.deadline).await?;
        let text = result["stdout"]
            .as_str()
            .unwrap_or_default()
            .split('\n')
            .filter(|line| {
                !line
                    .trim_start_matches(|c: char| {
                        crate::js_semantics::trim(&c.to_string()).is_empty()
                    })
                    .starts_with("{\"_keepalive\"")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let reply: Value =
            serde_json::from_str(crate::js_semantics::trim(&text)).unwrap_or(Value::Null);
        let ready = reply["ok"] == true
            && reply["result"]["runtime"]["state"] == "ready"
            && reply["result"]["runtime"]["reachable"] == true;
        if ready {
            Ok(json!({"ready":true}))
        } else {
            Ok(json!({"ready":false,"reason":"the Orca runtime is not ready (orca status)"}))
        }
    }
}
