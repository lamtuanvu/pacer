//! Sealed `_host.plugin.call` for Core plugin calls under the native owner.
//!
//! Core sends the same `spawn_spec` and `call_authority` bodies the serve
//! plugin service fetches over `/_internal/plugins`, plus the scope roots
//! (`$HOME`, `$PACER_HOME`, `$ACCOUNT_HOME`) of the call. The owner starts the
//! child when absent, answers `plugin.hello` once, and binds a call-scoped
//! capability session, so Core never spawns a second owner for the plugin id.

use crate::{
    CoreForward, PluginCapabilitySession, ProcessContext,
    bridge_listener::SharedOwner,
    call_resources_from_value, core_capability, executor_context_from_value,
    host_snapshots_from_value, observation_bootstrap_from_value, orca_context_from_value,
    owner::{OwnerError, ProcessOwner},
    session_for_call_in, worktree_context_from_value,
};
use pacer_plugin_host::{ProcessError, ScopeRoots, SpawnSpec};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt::Display,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, MutexGuard, watch};

const HELLO_DEADLINE: Duration = Duration::from_secs(5);
const DEFAULT_TTL_MS: u64 = 30_000;
const LOG_MAX_BYTES: usize = 1000;
/// Orca and hosts capability handlers lock the owner, which waits for this call's lane.
const REENTRANT_RESOURCES: &str =
    "orca and hosts resources re-enter the process owner and are not served over the bridge";

/// A failed sealed call with the `CoreError` code Core should raise.
pub(crate) struct CallFailure {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    /// The child's own JSON-RPC error reply, relayed; never an owner or Core failure.
    pub from_plugin: bool,
}

fn failure(code: &str, error: impl Display) -> CallFailure {
    CallFailure {
        code: code.to_owned(),
        message: error.to_string(),
        hint: None,
        from_plugin: false,
    }
}

fn refused(error: impl Display) -> CallFailure {
    failure("plugin_refused", error)
}

fn unavailable(error: impl Display) -> CallFailure {
    failure("plugin_unavailable", error)
}

fn expired() -> CallFailure {
    failure("plugin_timeout", "plugin call passed its absolute deadline")
}

fn cancelled() -> CallFailure {
    failure("plugin_timeout", "plugin call was cancelled")
}

/// Keep timeouts and the child's own `{message, data:{code, hint}}` error.
fn call_failure(error: OwnerError, fallback: &str) -> CallFailure {
    if let OwnerError::Process(text) = &error {
        if *text == ProcessError::Timeout.to_string() {
            return expired();
        }
        if *text == ProcessError::Cancelled.to_string() {
            return cancelled();
        }
        let owner_prefix = ProcessError::OwnerRefused(String::new()).to_string();
        if let Some(Ok(reply)) = text
            .strip_prefix(&owner_prefix)
            .map(serde_json::from_str::<Value>)
        {
            return CallFailure {
                code: reply["data"]["code"]
                    .as_str()
                    .unwrap_or(fallback)
                    .to_owned(),
                message: reply["message"]
                    .as_str()
                    .unwrap_or("plugin call refused")
                    .to_owned(),
                hint: reply["data"]["hint"].as_str().map(str::to_owned),
                from_plugin: false,
            };
        }
        let prefix = ProcessError::Unavailable(String::new()).to_string();
        if let Some(Ok(reply)) = text
            .strip_prefix(&prefix)
            .map(serde_json::from_str::<Value>)
            && let Some(message) = reply["message"].as_str()
        {
            return CallFailure {
                code: reply["data"]["code"]
                    .as_str()
                    .unwrap_or(fallback)
                    .to_owned(),
                message: message.to_owned(),
                hint: reply["data"]["hint"].as_str().map(str::to_owned),
                from_plugin: true,
            };
        }
    }
    failure(fallback, error)
}

fn remaining(until: Instant) -> Result<Duration, CallFailure> {
    let left = until.saturating_duration_since(Instant::now());
    if left.is_zero() {
        Err(expired())
    } else {
        Ok(left)
    }
}

/// Wait for a lock within the call's absolute deadline and cancellation.
async fn within<T>(
    until: Instant,
    cancel: &watch::Receiver<bool>,
    lock: impl Future<Output = T>,
) -> Result<T, CallFailure> {
    let mut cancel = cancel.clone();
    if *cancel.borrow() {
        return Err(cancelled());
    }
    tokio::select! {
        guard = tokio::time::timeout_at(until.into(), lock) => guard.map_err(|_| expired()),
        Ok(()) = cancel.changed() => Err(cancelled()),
    }
}

async fn acquire<'a>(
    owner: &'a SharedOwner,
    until: Instant,
    cancel: &watch::Receiver<bool>,
) -> Result<MutexGuard<'a, ProcessOwner>, CallFailure> {
    within(until, cancel, owner.lock()).await
}

/// Unique per call; the child echoes it on the call's capability requests.
fn call_token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("native-call-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Core-sealed spawn, hello, authority and scope roots for one call.
pub(crate) struct SealedCall {
    spec: SpawnSpec,
    hello: Value,
    authority: Value,
    roots: ScopeRoots,
    environment: HashMap<String, String>,
    core_methods: HashSet<String>,
    /// Features the child must have negotiated before Core lets the method run.
    required: Vec<String>,
}

impl SealedCall {
    /// `Ok(None)` keeps the bare call contract (call an already tracked child).
    pub(crate) fn from_params(params: &Value) -> Result<Option<Self>, &'static str> {
        let Some(spawn) = params.get("spawn") else {
            return Ok(None);
        };
        let argv = spawn
            .get("argv")
            .and_then(Value::as_array)
            .ok_or("missing spawn argv")?
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .filter(|argv| !argv.is_empty())
            .ok_or("invalid spawn argv")?;
        let cwd = spawn
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or("missing spawn cwd")?;
        let mut env = HashMap::new();
        if let Some(object) = spawn.get("env").and_then(Value::as_object) {
            for (key, value) in object {
                let text = value.as_str().ok_or("invalid spawn env")?;
                env.insert(key.clone(), text.to_owned());
            }
        }
        let hello = spawn
            .get("hello")
            .filter(|hello| hello.is_object())
            .cloned()
            .ok_or("missing spawn hello")?;
        let authority = params
            .get("authority")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !authority.is_object() {
            return Err("invalid authority");
        }
        let root = |name: &str| -> Result<Option<String>, &'static str> {
            match params.get("scopeRoots").and_then(|roots| roots.get(name)) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(path)) => Ok(Some(path.clone())),
                Some(_) => Err("invalid scopeRoots"),
            }
        };
        let roots = ScopeRoots {
            home: root("home")?,
            pacer_home: root("pacerHome")?,
            account_home: root("accountHome")?,
        };
        let mut environment = HashMap::new();
        match params.get("processEnv") {
            None | Some(Value::Null) => {}
            Some(Value::Object(object)) => {
                for (key, value) in object {
                    let text = value.as_str().ok_or("invalid processEnv")?;
                    environment.insert(key.clone(), text.to_owned());
                }
            }
            Some(_) => return Err("invalid processEnv"),
        }
        let mut core_methods = HashSet::new();
        match params.get("coreMethods") {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    let method = item
                        .as_str()
                        .filter(|method| core_capability(method).is_some())
                        .ok_or("invalid coreMethods")?;
                    core_methods.insert(method.to_owned());
                }
            }
            Some(_) => return Err("invalid coreMethods"),
        }
        let mut required = Vec::new();
        match params.get("requireFeatures") {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    let feature = item
                        .as_str()
                        .filter(|feature| feature_minimum(feature).is_some())
                        .ok_or("invalid requireFeatures")?;
                    required.push(feature.to_owned());
                }
            }
            Some(_) => return Err("invalid requireFeatures"),
        }
        Ok(Some(Self {
            spec: SpawnSpec {
                argv,
                cwd: cwd.into(),
                env,
            },
            hello,
            authority,
            roots,
            environment,
            core_methods,
            required,
        }))
    }
}

/// Start (when absent), hello (once) and call a plugin under the shared owner.
///
/// Returns `{value, hello, logs}`: `hello` carries the `{protocol, served}`
/// recorded when this child answered `plugin.hello`, so Core can restore
/// readiness even when it gave up on the call that ran the hello. `until` is
/// the caller's absolute deadline and covers the owner and lane waits and the
/// hello. The owner lock is held only to start the child and find its lane.
/// `core` carries the Core-sealed `coreMethods` back to the calling Core.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn call_sealed(
    owner: &SharedOwner,
    id: &str,
    method: &str,
    params: Value,
    until: Instant,
    cancel: &watch::Receiver<bool>,
    sealed: SealedCall,
    core: Option<CoreForward>,
) -> Result<Value, CallFailure> {
    let authority = &sealed.authority;
    let resources = call_resources_from_value(authority.get("resources").unwrap_or(&json!({})))
        .map_err(refused)?;
    let grants = authority
        .get("grants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
    let ttl = authority
        .get("ttlMs")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_TTL_MS);
    let observation = observation_bootstrap_from_value(authority).map_err(refused)?;
    let host_attach = host_snapshots_from_value(authority).map_err(refused)?;
    let orca_context = orca_context_from_value(authority).map_err(refused)?;
    let worktree_context = worktree_context_from_value(authority).map_err(refused)?;
    let executor_context = executor_context_from_value(authority).map_err(refused)?;
    // Core holds the Orca attempt session and live grant, so it must answer their effects.
    let core_orca = sealed
        .core_methods
        .iter()
        .any(|method| core_capability(method) == Some("orca"));
    if ((resources.orca_attempt.is_some() || resources.orca_live.is_some()) && !core_orca)
        || !resources.hosts.is_empty()
        || !host_attach.is_empty()
    {
        return Err(unavailable(REENTRANT_RESOURCES));
    }

    let lane = {
        let mut guard = acquire(owner, until, cancel).await?;
        guard.ensure(id, &sealed.spec).map_err(unavailable)?;
        guard
            .lane(id)
            .ok_or_else(|| unavailable(OwnerError::UnknownPlugin(id.into())))?
    };
    let process = ProcessContext {
        account_home: sealed.roots.account_home.clone(),
        environment: sealed.environment,
    };
    let mut session = session_for_call_in(
        &sealed.hello,
        resources,
        grants,
        Duration::from_millis(ttl),
        observation,
        Some(&host_attach),
        orca_context,
        worktree_context,
        executor_context,
        &process,
    )
    .map_err(refused)?;
    session.broker_mut().set_scope_roots(sealed.roots);
    // Give the session the Core-sealed method set before the hello so a child
    // that asks for one while answering `plugin.hello` is refused locally
    // (`capability_denied`) instead of reaching the native broker (R1), and
    // `$/resultChunk` transport requests are relayed once Core is bound.
    session.bind_core_methods(sealed.core_methods.clone());
    // Core forwarding binds only after the hello and the `requireFeatures` gate
    // pass (below): a child must not reach Core-run methods while it answers
    // `plugin.hello`, before Core knows whether it negotiated the feature.
    let core_forward = core.filter(|_| !sealed.core_methods.is_empty());
    session
        .bind_process_owner_hosts(owner.clone())
        .map_err(refused)?;
    if !core_orca {
        session
            .bind_process_owner_orca(owner.clone())
            .map_err(refused)?;
    }
    session
        .bind_process_owner_worktree()
        .await
        .map_err(refused)?;
    session.bind_process_owner_executor().map_err(refused)?;
    let session = Arc::new(Mutex::new(session));
    let answer = |session: Arc<Mutex<PluginCapabilitySession>>| {
        move |capability: String, body: Value, meta: Option<Value>| {
            let session = session.clone();
            async move { session.lock().await.answer(&capability, body, meta).await }
        }
    };

    // A reentrant plugin's calls share the child and each carries its own
    // capability token; any other plugin answers one call at a time.
    let reentrant = sealed.hello["manifest"]["reentrant"] == true;
    let (_shared, _exclusive) = if reentrant {
        (Some(within(until, cancel, lane.gate().read()).await?), None)
    } else {
        (
            None,
            Some(within(until, cancel, lane.gate().write()).await?),
        )
    };
    let outcome = async {
        let hello = match lane.ready_hello() {
            Some(info) => info,
            None if lane.is_ready() => Value::Null,
            None => {
                let _hello = within(until, cancel, lane.hello_turn().lock()).await?;
                match lane.ready_hello() {
                    Some(info) => info,
                    None if lane.is_ready() => Value::Null,
                    None => {
                        let wait = remaining(until)?.min(HELLO_DEADLINE);
                        let reply = lane
                            .process()
                            .request_with_handler(
                                "plugin.hello",
                                sealed.hello.clone(),
                                wait,
                                Some(cancel),
                                answer(session.clone()),
                            )
                            .await
                            .map_err(|error| call_failure(error.into(), "plugin_refused"))?;
                        let info = ready_info(&reply, &sealed.hello);
                        lane.mark_ready(Some(info.clone()));
                        info
                    }
                }
            }
        };
        // A child readied without a recorded summary has no known features.
        if let Some(feature) = sealed.required.iter().find(|feature| {
            !hello["features"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item == feature.as_str()))
        }) {
            return Err(failure(
                "capability_denied",
                format!("{method} requires the negotiated {feature} feature"),
            ));
        }
        // The gate passed: only now may this call's capability requests reach Core.
        if let Some(core) = core_forward {
            // Pass whether the child negotiated `chunkedResults` so Core only
            // assembles chunks the child was admitted to send.
            let chunked = hello["features"]
                .as_array()
                .is_some_and(|features| features.iter().any(|feature| feature == "chunkedResults"));
            session
                .lock()
                .await
                .bind_core(core, sealed.core_methods.clone(), chunked);
        }
        let metadata = reentrant.then(|| json!({"capabilityCall": call_token()}));
        let value = lane
            .process()
            .request_with_metadata(
                method,
                params,
                metadata,
                remaining(until)?,
                Some(cancel),
                answer(session.clone()),
            )
            .await
            .map_err(|error| call_failure(error.into(), "plugin_unavailable"))?;
        Ok::<_, CallFailure>((value, hello))
    }
    .await;
    let logs = session.lock().await.take_logs();
    let (value, hello) = outcome?;
    let logs = logs
        .into_iter()
        .map(|(level, message)| {
            let mut text = if level == "info" {
                message
            } else {
                format!("[{level}] {message}")
            };
            if text.len() > LOG_MAX_BYTES {
                let mut cut = LOG_MAX_BYTES;
                while !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
            }
            Value::String(text)
        })
        .collect::<Vec<_>>();
    Ok(json!({"value": value, "hello": hello, "logs": logs}))
}

/// The protocol minor that introduced each host feature (`registry.ts` hello).
fn feature_minimum(feature: &str) -> Option<u32> {
    match feature {
        "chunkedResults" => Some(1),
        "httpBodyChunks" => Some(2),
        "fileWriteChunks" | "plannerInstallTransactions" => Some(4),
        "policyObservations" => Some(6),
        "policyRedactionMetadata" => Some(8),
        _ => None,
    }
}

/// `{protocol, served, features}` for a child's `plugin.hello` reply to the
/// sealed `hello`: features are those the host offered, the child answered and
/// the child's protocol minor admits, as the flag-off registry negotiates.
pub fn ready_info(reply: &Value, hello: &Value) -> Value {
    let protocol = reply["protocol"].as_str().unwrap_or("");
    let mut served = vec!["diagnostic".to_owned()];
    for point in reply["contributes"].as_array().into_iter().flatten() {
        if let Some(name) = point.as_str()
            && !served.iter().any(|known| known == name)
        {
            served.push(name.to_owned());
        }
    }
    let mut parts = protocol.split('.');
    let minor = (parts.next() == Some("1"))
        .then(|| parts.next().and_then(|part| part.parse::<u32>().ok()))
        .flatten()
        .unwrap_or(0);
    let offered = hello["features"].as_array().cloned().unwrap_or_default();
    let mut features: Vec<&str> = Vec::new();
    for feature in reply["features"].as_array().into_iter().flatten() {
        if let Some(name) = feature.as_str()
            && offered.iter().any(|item| item == name)
            && feature_minimum(name).is_some_and(|minimum| minor >= minimum)
            && !features.contains(&name)
        {
            features.push(name);
        }
    }
    json!({"protocol": protocol, "served": served, "features": features})
}

#[cfg(test)]
mod tests {
    use super::ready_info;
    use serde_json::json;

    #[test]
    fn ready_info_keeps_offered_features_the_protocol_admits() {
        let hello = json!({"features": ["chunkedResults", "plannerInstallTransactions"]});
        let reply = |protocol: &str| {
            json!({"protocol": protocol, "contributes": ["planner", "planner"],
                "features": ["plannerInstallTransactions", "chunkedResults", "chunkedResults", "fileWriteChunks", "madeUp"]})
        };
        assert_eq!(
            ready_info(&reply("1.10.0"), &hello),
            json!({"protocol": "1.10.0", "served": ["diagnostic", "planner"],
                "features": ["plannerInstallTransactions", "chunkedResults"]})
        );
        assert_eq!(
            ready_info(&reply("1.3.0"), &hello)["features"],
            json!(["chunkedResults"])
        );
        assert_eq!(ready_info(&reply("2.4.0"), &hello)["features"], json!([]));
        assert_eq!(
            ready_info(&json!({"protocol": "1.10.0"}), &hello)["features"],
            json!([])
        );
    }
}
