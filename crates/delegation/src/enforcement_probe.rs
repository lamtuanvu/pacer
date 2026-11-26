//! Native `dispatch.enforcement.probe` (`probeNativeControl` / `certifyExecutor`
//! in `src/dispatch/enforcement.ts:325-382`). A job runs a quota-using canary:
//! it asks the agent-session plugin for the host-observed control, launches the
//! selected native CLI with a guard that must deny a nested subagent, and only
//! writes a certificate when the marker and the correlated tool result agree.
#![allow(clippy::result_large_err)]
use pacer_dispatch::VersionCache;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock_async},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::runtime::PluginCalls;

/// The B1 job runtime: create a job file, run the canary and settle the job.
/// `pacer-server` owns the implementation; this crate only names the effect.
pub trait JobStarter: Send + Sync {
    fn start<'a>(
        &'a self,
        ctx: &'a Ctx,
        kind: &'a str,
        target: &'a str,
        steps: &'a [String],
        work: OpFuture<'a>,
    ) -> OpFuture<'a>;
}

const SECRET_ENV: &[&str] = &[
    "PACER_HOST_SOCKET_KEY",
    "PACER_INTERNAL_TOKEN",
    "PACER_NATIVE_CONFIG_SYNC_KEY",
];

fn not_allowed(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
}

/// `shq` / `shellCommand` from `src/install/fsx.ts:27-34`.
fn shq(value: &str) -> String {
    if value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/_.:=@%+-".contains(&b))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// `strictClaudeLaunch` (`src/dispatch/enforcement.ts:111-123`): a 0600 hook
/// settings file in the canary directory, then `--settings` before `--`.
fn strict_claude_launch(argv: &[String], guard_argv: &[String], root: &Path) -> Result<Vec<String>, CoreError> {
    fs::create_dir_all(root).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let settings = root.join("strict-claude-settings.json");
    let command = guard_argv.iter().map(|s| shq(s)).collect::<Vec<_>>().join(" ");
    let body = json!({"hooks":{"PreToolUse":[{"matcher":"Agent|Task","hooks":[{"type":"command","command":command,"timeout":15}]}]}});
    let temp = root.join(format!(
        "strict-claude-settings.json.{:x}.tmp",
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
    ));
    {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temp)
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        file.write_all(body.to_string().as_bytes())
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    }
    fs::rename(&temp, &settings).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let mut out = argv.to_vec();
    let at = out.iter().position(|s| s == "--").unwrap_or(out.len().saturating_sub(1));
    out.splice(at..at, ["--settings".into(), settings.to_string_lossy().into_owned()]);
    Ok(out)
}

/// `observeClaudeCanary` (`src/dispatch/enforcement.ts:27-55`): correlate the
/// denied tool result with the attempted invocation; a marker alone is not proof.
fn observe_claude_canary(output: &str, entry: &str) -> Value {
    use std::collections::HashMap;
    let mut uses: HashMap<String, String> = HashMap::new();
    let mut results: HashMap<String, (bool, bool)> = HashMap::new();
    let mut advertised = false;
    let mut agent_advertised = false;
    for line in output.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        if event["type"] == "system" && event["subtype"] == "init" {
            if let Some(tools) = event["tools"].as_array() {
                advertised = tools.iter().any(|t| t.as_str() == Some(entry));
                agent_advertised = tools.iter().any(|t| t.as_str() == Some("Agent"));
            }
        }
        let Some(content) = event["message"]["content"].as_array() else { continue };
        for item in content {
            if let (Some(id), Some(name)) = (
                item["id"].as_str(),
                item["name"].as_str(),
            ) && item["type"] == "tool_use"
                && ["Agent", "Task"].contains(&name)
            {
                uses.insert(id.to_owned(), name.to_owned());
            }
            if let Some(id) = item["tool_use_id"].as_str() && item["type"] == "tool_result" {
                let body = match &item["content"] {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                results.insert(
                    id.to_owned(),
                    (
                        item["is_error"] == true,
                        body.contains("pacer: native subagents are blocked for this managed attempt"),
                    ),
                );
            }
        }
    }
    let matching: Vec<_> = uses
        .iter()
        .filter(|(_, name)| {
            name.as_str() == entry
                || (entry == "Task" && name.as_str() == "Agent" && advertised && !agent_advertised)
        })
        .collect();
    let child_started = uses.keys().any(|id| results.get(id).is_some_and(|r| !r.0));
    let blocked = !matching.is_empty()
        && matching.iter().all(|(id, _)| {
            results.get(*id).is_some_and(|r| r.0 && r.1)
        });
    let mut out = json!({"attempted": !matching.is_empty(), "blocked": blocked, "childStarted": child_started});
    if !blocked {
        out["reason"] = json!(format!("The {entry} native tool did not return a correlated Pacer denial"));
    }
    out
}

fn uncertified(reason: impl Into<String>) -> Value {
    json!({"state": "uncertified", "reason": reason.into()})
}

/// The canary body inside `certifyExecutor`. Returns the `CertificateStatus`.
async fn canary(
    ctx: &Ctx,
    strategy: &Value,
    plan: &Value,
    control: &Value,
) -> Result<Value, CoreError> {
    let mechanism = control["mechanism"].as_str().unwrap_or_default();
    if mechanism != "hook" {
        return Ok(uncertified("This native control adapter does not yet have a host-observed canary"));
    }
    let runner = plan["runner"].as_str().unwrap_or_default();
    let agent = plan["agent"].as_str().unwrap_or_default();
    let binary = plan["binary"].as_str().unwrap_or_default();
    let account = &strategy["accounts"][plan["account"].as_str().unwrap_or_default()];
    let entries = control["entryPoints"].as_array().cloned().unwrap_or_default();
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "pacer-control-canary-{}-{nonce:x}",
        std::process::id()
    ));
    fs::create_dir_all(&root).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let result = async {
        for entry in &entries {
            let Some(name) = entry.as_str() else { continue };
            let marker_name: String = name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect();
            let marker = root.join(format!("denied-{marker_name}"));
            let prompt = format!(
                "This is a Pacer native-control verification. Invoke the {name} native subagent tool now with a simple task: reply with the word canary. Do not use a shell, terminal, or direct provider API. After the tool is denied, stop."
            );
            let repo = "";
            let mut argv = pacer_dispatch::guards::enforcement_canary_argv(
                ctx, strategy, runner, &prompt, repo,
                root.to_string_lossy().as_ref(), "canary",
            )
            .map_err(not_allowed)?;
            if agent == "claude-code" {
                let guard = plan["guardArgv"].as_array().map(|a| {
                    a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()
                }).unwrap_or_default();
                argv = strict_claude_launch(&argv, &guard, &root)?;
            }
            let mut env = ctx.env.clone();
            env.insert("PACER_ROLE".into(), "executor".into());
            env.insert("PACER_ENFORCEMENT_MODE".into(), "strict".into());
            env.insert("PACER_ENFORCEMENT_TOKEN".into(), format!("pet_{}", "0".repeat(64)));
            env.insert("PACER_CANARY_MARKER".into(), marker.to_string_lossy().into_owned());
            for name in ["PACER_WORK_GRANT", "PACER_AUTH_TOKEN", "PACER_HOST_SOCKET",
                "CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
                env.remove(name);
            }
            for name in SECRET_ENV {
                env.remove(*name);
            }
            if plan["account"].as_str().unwrap_or_default() != "default" {
                let folder = account["home"].as_str();
                let folder = if account["source"].as_str() == Some("orca") {
                    None
                } else {
                    folder
                };
                let Some(folder) = folder else {
                    return Ok(json!({"attempted": false, "blocked": false, "childStarted": false,
                        "reason": "The selected account has no resolvable configuration folder"}));
                };
                let folder = if let Some(rest) = folder.strip_prefix("~/") {
                    ctx.home.join(rest).to_string_lossy().into_owned()
                } else {
                    folder.to_owned()
                };
                if account["kind"].as_str() == Some("claude") {
                    env.insert("CLAUDE_CONFIG_DIR".into(), folder.clone());
                }
                if account["kind"].as_str() == Some("codex") {
                    env.insert("CODEX_HOME".into(), folder);
                }
            }
            let mut command = tokio::process::Command::new(binary);
            command.args(&argv[1..]).current_dir(&root).envs(&env)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            let run = command.output();
            let output = match tokio::time::timeout(Duration::from_secs(120), run).await {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    return Ok(json!({"attempted": false, "blocked": false, "childStarted": false,
                        "reason": error.to_string()}));
                }
                Err(_) => {
                    return Ok(json!({"attempted": marker.exists(), "blocked": false, "childStarted": false,
                        "reason": "The native agent timed out during the child-control check"}));
                }
            };
            if !marker.exists() {
                return Ok(json!({"attempted": false, "blocked": false, "childStarted": false,
                    "reason": format!("The {name} guard did not run; connect the selected account and approve its hooks")}));
            }
            let content = fs::read_to_string(&marker).unwrap_or_default();
            if content != "native-child.denied" {
                return Ok(json!({"attempted": true, "blocked": false, "childStarted": false,
                    "reason": "The native guard did not record a denial"}));
            }
            let stdout = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(1024 * 1024)]);
            let observed = if agent == "claude-code" {
                observe_claude_canary(&stdout, name)
            } else {
                json!({"attempted": false, "blocked": false, "childStarted": false,
                    "reason": "This adapter has no native tool-result observer"})
            };
            if observed["attempted"] != true || observed["blocked"] != true || observed["childStarted"] == true {
                return Ok(observed);
            }
        }
        Ok(json!({"attempted": true, "blocked": true, "childStarted": false,
            "entries": entries}))
    }.await;
    let _ = fs::remove_dir_all(&root);
    result
}

/// `certifyExecutor` (`src/dispatch/enforcement.ts:325-338`): hold the
/// `enforcement-<digest(key)>` lock (600 s), compare the fingerprint before and
/// after the canary and write the certificate row on success.
async fn certify(ctx: &Ctx, plan: &Value, strategy: &Value, control: &Value) -> Result<Value, CoreError> {
    let key = plan["key"].as_str().unwrap_or_default();
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    let options = LockOptions { timeout: Duration::from_secs(600), stale: Duration::from_secs(600) };
    with_lock_async(ctx, &format!("enforcement-{digest}"), options, || async {
        let before = plan["fingerprint"].as_str().unwrap_or_default().to_owned();
        let result = canary(ctx, strategy, plan, control).await?;
        if result["attempted"] != true || result["blocked"] != true
            || result["childStarted"] == true || plan["fingerprint"].as_str() != Some(before.as_str())
        {
            let mut state = pacer_lifecycle::AdmissionState::open(&ctx.pacer_home)
                .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
            let db = state.tasks.connection()
                .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
            db.execute("DELETE FROM enforcement_certificates WHERE target=?", [key])
                .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
            return Ok(uncertified(result["reason"].as_str().unwrap_or(
                "Native child blocking was not observed in the selected launch environment")));
        }
        let mut state = pacer_lifecycle::AdmissionState::open(&ctx.pacer_home)
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        let db = state.tasks.connection()
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        let now = (ctx.now * 1000.0).floor() / 1000.0;
        let expires = now + 86_400.0;
        db.execute(
            "INSERT OR REPLACE INTO enforcement_certificates(target,fingerprint,probed_at,expires,evidence) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![key, before, now, expires, result.to_string()],
        ).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        Ok(json!({"state": "certified", "probedAt": now, "expiresAt": expires}))
    }).await.map_err(|e| CoreError::new(Code::Internal, e.to_string()))?
}

/// The job body: the probe's certificate decision is settled as a job step.
async fn probe_job(
    ctx: &Ctx,
    strategy: &Value,
    runner: &str,
    repo: &str,
    plugins: &dyn PluginCalls,
    cache: &VersionCache,
) -> Result<Value, CoreError> {
    let plan = pacer_dispatch::guards::enforcement_probe_plan(ctx, strategy, runner, repo, cache)
        .await
        .map_err(not_allowed)?;
    if let Some(reason) = plan["unsupported"].as_str() {
        return Err(CoreError::new(Code::NotAllowed, reason));
    }
    let control = plugins
        .call(
            ctx,
            "pacer-agent-session",
            "agentSession.delegationControl",
            json!({"agent": plan["agent"], "version": plan["version"]}),
            Duration::from_secs(30),
        )
        .await?;
    certify(ctx, &plan, strategy, &control).await
}

/// Start a native enforcement probe job and return `{job}`.
pub fn probe<'a>(
    ctx: &'a Ctx,
    strategy: &Value,
    runner: &'a str,
    repo: &'a str,
    plugins: &'a dyn PluginCalls,
    jobs: &'a dyn JobStarter,
    cache: &'a VersionCache,
) -> OpFuture<'a> {
    let ctx = ctx.clone();
    let strategy = strategy.clone();
    let runner = runner.to_owned();
    let repo = repo.to_owned();
    let target = format!("{runner}:{repo}");
    let steps = vec!["Probe native child control".to_owned()];
    Box::pin(async move {
        let work: OpFuture<'_> = Box::pin(async {
            match probe_job(&ctx, &strategy, &runner, &repo, plugins, cache).await {
                Ok(status) if status["state"] == "certified" => Ok(json!({
                    "state": "passed", "detail": "Native child blocking verified"
                })),
                Ok(status) => Err(CoreError::new(
                    Code::NotAllowed,
                    status["reason"].as_str().unwrap_or("Native child blocking was not observed"),
                )),
                Err(error) => Err(error),
            }
        });
        let job = jobs.start(&ctx, "enforcement.probe", &target, &steps, work).await?;
        Ok(json!({"job": job}))
    })
}

#[cfg(test)]
#[path = "enforcement_probe/tests.rs"]
mod tests;

/// A test double: neither plugin calls nor a job runtime are available.
pub struct NoJobs;
impl JobStarter for NoJobs {
    fn start<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        _: &'a str,
        _: &'a [String],
        _: OpFuture<'a>,
    ) -> OpFuture<'a> {
        Box::pin(async { Err(CoreError::new(Code::Unavailable, "job runtime unavailable")) })
    }
}

