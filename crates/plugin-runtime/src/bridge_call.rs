//! Sealed `_host.plugin.call` for Core plugin calls under the native owner.
//!
//! Core sends the same `spawn_spec` and `call_authority` bodies the serve
//! plugin service fetches over `/_internal/plugins`, plus the scope roots
//! (`$HOME`, `$PACER_HOME`, `$ACCOUNT_HOME`) of the call. The owner starts the
//! child when absent, answers `plugin.hello` once, and binds a call-scoped
//! capability session, so Core never spawns a second owner for the plugin id.

use crate::{
    bridge_listener::SharedOwner, call_resources_from_value, executor_context_from_value,
    host_snapshots_from_value, observation_bootstrap_from_value, orca_context_from_value,
    session_for_call, session_from_hello, worktree_context_from_value,
};
use pacer_plugin_host::{ScopeRoots, SpawnSpec};
use serde_json::{Value, json};
use std::{collections::HashMap, fmt::Display, time::Duration};

const HELLO_DEADLINE: Duration = Duration::from_secs(5);
const IDLE_SESSION: Duration = Duration::from_secs(300);
const DEFAULT_TTL_MS: u64 = 30_000;
const LOG_MAX_BYTES: usize = 1000;

/// A failed sealed call with the `CoreError` code Core should raise.
pub(crate) struct CallFailure {
    pub code: &'static str,
    pub message: String,
}

fn refused(error: impl Display) -> CallFailure {
    CallFailure {
        code: "plugin_refused",
        message: error.to_string(),
    }
}

fn unavailable(error: impl Display) -> CallFailure {
    CallFailure {
        code: "plugin_unavailable",
        message: error.to_string(),
    }
}

/// Core-sealed spawn, hello, authority and scope roots for one call.
pub(crate) struct SealedCall {
    spec: SpawnSpec,
    hello: Value,
    authority: Value,
    roots: ScopeRoots,
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
        Ok(Some(Self {
            spec: SpawnSpec {
                argv,
                cwd: cwd.into(),
                env,
            },
            hello,
            authority,
            roots,
        }))
    }
}

/// Start (when absent), hello (once) and call a plugin under the shared owner.
///
/// Returns `{value, hello, logs}`: `hello` carries `{protocol, served}` only on
/// the call that completed `plugin.hello`, so Core can record readiness.
pub(crate) async fn call_sealed(
    owner: &SharedOwner,
    id: &str,
    method: &str,
    params: Value,
    deadline: Duration,
    sealed: SealedCall,
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

    let mut guard = owner.lock().await;
    guard.ensure(id, &sealed.spec).map_err(unavailable)?;
    let mut session = session_for_call(
        &sealed.hello,
        resources,
        grants,
        Duration::from_millis(ttl),
        observation,
        Some(&host_attach),
        orca_context,
        worktree_context,
        executor_context,
    )
    .map_err(refused)?;
    session.broker_mut().set_scope_roots(sealed.roots);
    session
        .bind_process_owner_hosts(owner.clone())
        .map_err(refused)?;
    session
        .bind_process_owner_orca(owner.clone())
        .map_err(refused)?;
    session
        .bind_process_owner_worktree()
        .await
        .map_err(refused)?;
    session.bind_process_owner_executor().map_err(refused)?;
    guard
        .install_capability_session(id, session)
        .map_err(unavailable)?;

    let hello = if guard.is_ready(id) {
        Value::Null
    } else {
        let reply = guard
            .call_plugin(id, "plugin.hello", sealed.hello.clone(), HELLO_DEADLINE)
            .await
            .map_err(refused)?;
        guard.mark_ready(id);
        ready_info(&reply)
    };
    let value = guard
        .call_plugin(id, method, params, deadline)
        .await
        .map_err(unavailable);
    let logs = match guard.capability_session(id) {
        Some(session) => session.lock().await.take_logs(),
        None => Vec::new(),
    };
    // Drop call-scoped natives; keep hello-only between calls.
    if let Ok(idle) = session_from_hello(&sealed.hello, IDLE_SESSION) {
        let _ = guard.install_capability_session(id, idle);
    }
    drop(guard);
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
    Ok(json!({"value": value?, "hello": hello, "logs": logs}))
}

fn ready_info(reply: &Value) -> Value {
    let protocol = reply["protocol"].as_str().unwrap_or("");
    let mut served = vec!["diagnostic".to_owned()];
    for point in reply["contributes"].as_array().into_iter().flatten() {
        if let Some(name) = point.as_str()
            && !served.iter().any(|known| known == name)
        {
            served.push(name.to_owned());
        }
    }
    json!({"protocol": protocol, "served": served})
}
