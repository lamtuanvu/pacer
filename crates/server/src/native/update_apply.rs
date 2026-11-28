//! Native `update.apply`: preflight, a shared `state/jobs` job and the update
//! worker. Rust owns the whole path; there is no Core effects bridge.
//!
//! The HTTP door starts the job and returns its record at once (`daemon = true`);
//! the stdio door runs it on a spawned task and writes the reply when it settles.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
};
use pacer_lifecycle::jobs;
use pacer_update::{
    apply, manifest,
    replace::System,
    run::{
        self, RestartOutcome, Step, StepState, UpdateHost, UpdateInputs, UpdateOptions,
        UpdateResult,
    },
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const STEPS: [&str; 5] = [
    "Download",
    "Verify",
    "Replace",
    "Refresh integrations",
    "Restart",
];
const INTEGRATION_AGENTS: [&str; 4] = ["claude-code", "codex", "cursor", "opencode"];

/// The persisted job and its change handle, shared with the worker task.
#[derive(Clone)]
struct StepApi {
    ctx: Ctx,
    id: String,
    job: Arc<Mutex<Value>>,
}

fn job_path(ctx: &Ctx, id: &str) -> PathBuf {
    ctx.pacer_home
        .join("state")
        .join("jobs")
        .join(format!("{id}.json"))
}

impl StepApi {
    fn save(ctx: &Ctx, id: &str, job: &Value) {
        let _ = write_private(
            &job_path(ctx, id),
            &serde_json::to_vec(job).unwrap_or_default(),
        );
        if let Some(value) = jobs::published(job, &json!(ctx.env)) {
            pacer_store::publish(
                ctx,
                &[json!({
                    "type": "entity",
                    "data": {"kind": "job", "id": id, "value": value}
                })],
            );
        }
    }

    fn change(&self, name: &str, state: &str, detail: Option<&str>) {
        let mut guard = self.job.lock().unwrap_or_else(|e| e.into_inner());
        let latest = guard.clone();
        let _ = jobs::update(&mut guard, &latest, name, state, detail);
        let value = guard.clone();
        drop(guard);
        Self::save(&self.ctx, &self.id, &value);
    }

    fn settle(&self, error: Option<&CoreError>) -> Value {
        let mut guard = self.job.lock().unwrap_or_else(|e| e.into_inner());
        let latest = guard.clone();
        let lifecycle_error = error.map(error_code);
        let value = jobs::finish(
            &guard,
            &latest,
            self.ctx.now,
            true,
            lifecycle_error.as_ref(),
        );
        *guard = value.clone();
        drop(guard);
        Self::save(&self.ctx, &self.id, &value);
        value
    }
}

fn error_code(error: &CoreError) -> pacer_lifecycle::Error {
    pacer_lifecycle::Error::new("failed", error.message.clone())
}

fn new_id() -> String {
    use rand::Rng;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let rand: u64 = rand::rng().random();
    format!("{stamp:x}{rand:x}")
}

fn running_job_by_id(ctx: &Ctx, id: &str) -> Option<Value> {
    serde_json::from_slice(&fs::read(job_path(ctx, id)).ok()?).ok()
}

fn running_job(ctx: &Ctx) -> Option<Value> {
    let dir = ctx.pacer_home.join("state").join("jobs");
    let entries = fs::read_dir(dir).ok()?;
    let mut found: Vec<Value> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            if !jobs::valid_id(id) {
                return None;
            }
            let job: Value = serde_json::from_slice(&fs::read(entry.path()).ok()?).ok()?;
            (job["kind"] == "update.apply" && job["state"] == "running").then_some(job)
        })
        .collect();
    found.sort_by(|a, b| {
        let left = b["startedAt"].as_f64().unwrap_or(0.0);
        let right = a["startedAt"].as_f64().unwrap_or(0.0);
        left.partial_cmp(&right)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    found.into_iter().next()
}

/// The host callbacks the pure update job cannot own.
struct NativeHost {
    step: StepApi,
    ctx: Ctx,
}

impl UpdateHost for NativeHost {
    fn progress(&mut self, step: Step, state: StepState, detail: Option<&str>) {
        self.step.change(step.name(), state.as_str(), detail);
    }

    fn refresh_integrations(&mut self, binary: &Path) -> Vec<String> {
        let mut lines = Vec::new();
        let manifest = read_install_manifest(&self.ctx);
        let recorded = manifest
            .get("planners")
            .and_then(Value::as_object)
            .is_some_and(|planners| {
                planners
                    .keys()
                    .any(|key| INTEGRATION_AGENTS.contains(&key.split('#').next().unwrap_or(key)))
            });
        if recorded {
            match refresh_with_binary(&self.ctx, binary) {
                Ok(rows) => lines.extend(rows),
                Err(()) => lines.push(
                    "WARNING: could not refresh integrations with the replacement binary; run pacer doctor"
                        .into(),
                ),
            }
        }
        lines.extend(refresh_strategy(&self.ctx));
        lines
    }

    fn migrate_strategy(&mut self) -> Vec<String> {
        refresh_strategy(&self.ctx)
    }

    fn restart_service(&mut self, binary: &Path, _: &str) -> Result<RestartOutcome, String> {
        Ok(restart_after_update(&self.ctx, binary))
    }

    fn staging(&self) -> &dyn pacer_update::replace::Staging {
        &System
    }
}

fn read_install_manifest(ctx: &Ctx) -> Value {
    fs::read_to_string(ctx.pacer_home.join("install-manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({"version": 1, "planners": {}}))
}

fn refresh_strategy(ctx: &Ctx) -> Vec<String> {
    let path = ctx.pacer_home.join("strategy.yaml");
    if !path.exists() {
        return Vec::new();
    }
    match pacer_config::strategy::migrate_strategy(&path, None) {
        Ok(result) => pacer_config::strategy::migration_lines(&path, &result),
        Err(error) => vec![format!("WARNING: could not migrate strategy: {error}")],
    }
}

/// `<new binary> integrations refresh --json`, bounded like TypeScript's 30 s call.
fn refresh_with_binary(ctx: &Ctx, binary: &Path) -> Result<Vec<String>, ()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ())?;
    runtime.block_on(async {
        let child = tokio::process::Command::new(binary)
            .args(["integrations", "refresh", "--json"])
            .envs(&ctx.env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
            .await
            .map_err(|_| ())
            .and_then(|out| out.map_err(|_| ()))?;
        let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| ())?;
        let rows = value.as_array().ok_or(())?;
        let mut lines = Vec::new();
        for row in rows {
            let target = row.get("target").and_then(Value::as_str).ok_or(())?;
            let state = row.get("state").and_then(Value::as_str).ok_or(())?;
            if !["current", "refreshed", "conflict", "failed"].contains(&state) {
                return Err(());
            }
            let failed = state == "failed" || state == "conflict";
            let mut line = format!("{}{target}: {state}", if failed { "WARNING: " } else { "" });
            if let Some(detail) = row.get("detail").and_then(Value::as_str) {
                line.push_str(&format!(": {detail}"));
            }
            if let Some(hint) = row.get("hint").and_then(Value::as_str) {
                line.push_str(&format!(". {hint}"));
            }
            lines.push(line);
        }
        if output.status.code() != Some(0)
            && !rows.iter().any(|row| {
                matches!(
                    row.get("state").and_then(Value::as_str),
                    Some("failed" | "conflict")
                )
            })
        {
            lines.push("WARNING: replacement integration refresh failed; run pacer doctor".into());
        }
        Ok(lines)
    })
}

/// `restartAfterUpdate` from `src/service/index.ts`: only a registered service whose
/// plist/unit points at the new binary is restarted, through argv (SEC-5).
fn restart_after_update(ctx: &Ctx, binary: &Path) -> RestartOutcome {
    let registration = if cfg!(target_os = "macos") {
        ctx.home.join("Library/LaunchAgents/com.pacer.serve.plist")
    } else {
        ctx.home.join(".config/systemd/user/pacer-serve.service")
    };
    let text = fs::read_to_string(&registration).unwrap_or_default();
    if !text.contains(&binary.to_string_lossy().into_owned()) {
        return RestartOutcome {
            restarted: false,
            summary: None,
            warning: None,
        };
    }
    let result = if cfg!(target_os = "macos") {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("launchctl")
                .args(["kickstart", "-k"])
                .arg(format!("gui/{}/com.pacer.serve", nix::unistd::getuid()))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        }
        #[cfg(not(target_os = "macos"))]
        {
            return RestartOutcome {
                restarted: false,
                summary: None,
                warning: None,
            };
        }
    } else {
        std::process::Command::new("systemctl")
            .args(["--user", "restart", "pacer-serve.service"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    };
    match result {
        Ok(status) if status.success() => RestartOutcome {
            restarted: true,
            summary: None,
            warning: None,
        },
        Ok(status) => RestartOutcome {
            restarted: false,
            summary: None,
            warning: Some(format!("service restart exited {status}")),
        },
        Err(error) => RestartOutcome {
            restarted: false,
            summary: None,
            warning: Some(error.to_string()),
        },
    }
}

fn inputs(ctx: &Ctx) -> UpdateInputs {
    UpdateInputs {
        env: ctx.env.clone(),
        pacer_home: ctx.pacer_home.clone(),
        exec_path: run::exec_path(&ctx.env),
        standalone: apply::standalone(&ctx.env),
        version: pacer_update::current_version().to_owned(),
        platform: manifest::host_platform(),
        nightly: run::channel(&ctx.env, &ctx.pacer_home),
    }
}

/// An executor session (or an Orca worktree of a configured provider) cannot upgrade.
fn executor_check(ctx: &Ctx) -> Result<(), CoreError> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let providers = || {
        pacer_config::strategy::load_strategy(&ctx.pacer_home)
            .ok()
            .and_then(|strategy| {
                strategy
                    .get("runners")
                    .and_then(Value::as_object)
                    .map(|runners| runners.keys().cloned().collect())
            })
            .unwrap_or_default()
    };
    if pacer_lifecycle::files_search::executor_session(ctx, &cwd, providers) {
        return Err(CoreError::new(
            Code::NotAllowed,
            "PACER_ROLE=executor: upgrades are not allowed from a delegated task.",
        ));
    }
    Ok(())
}

fn worker(ctx: &Ctx, step: StepApi, inputs: UpdateInputs) -> Result<(), CoreError> {
    let mut host = NativeHost {
        step: step.clone(),
        ctx: ctx.clone(),
    };
    let options = UpdateOptions::default();
    let UpdateResult { code, err, .. } = run::run_update(&options, &inputs, &mut host);
    if code != 0 {
        let error = CoreError::new(Code::Internal, err);
        step.settle(Some(&error));
        return Err(error);
    }
    // After a replacement the next connection must re-check its integrations.
    let _ = write_private(&ctx.pacer_home.join("setup-health.required"), b"1\n");
    step.settle(None);
    Ok(())
}

/// Registry entry for the HTTP door: reply with the job, keep working on a task.
pub(crate) fn update_apply_daemon(ctx: &Ctx, params: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(update_apply(ctx, params, true))
}

/// `startJob` for `update.apply`. `daemon = true` replies with the created job and
/// runs the job on a task; `daemon = false` waits for the job to settle.
pub(crate) async fn update_apply(
    ctx: &Ctx,
    params: Value,
    daemon: bool,
) -> Result<Value, CoreError> {
    apply::admit(ctx, &params)?;
    executor_check(ctx)?;
    let inputs = inputs(ctx);
    apply::preflight(ctx, &inputs)?;

    if let Some(job) = running_job(ctx) {
        return Ok(json!({"job": job}));
    }
    let ctx = ctx.at_now();
    let id = new_id();
    let steps: Vec<Value> = STEPS
        .iter()
        .map(|name| json!({"name": name, "state": "pending"}))
        .collect();
    let job = jobs::create(
        &id,
        "update.apply",
        "pacer",
        &steps,
        ctx.now,
        std::process::id() as f64,
        false,
    );
    let step = StepApi {
        ctx: ctx.clone(),
        id: id.clone(),
        job: Arc::new(Mutex::new(job.clone())),
    };
    StepApi::save(&ctx, &id, &job);
    crate::native::msg_write_sync::trace("update.apply", None);

    if daemon {
        let task = step.clone();
        let task_ctx = ctx.clone();
        tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || worker(&task_ctx, task, inputs)).await;
        });
        Ok(json!({"job": job}))
    } else {
        let run_ctx = ctx.clone();
        let _ = tokio::task::spawn_blocking(move || worker(&run_ctx, step, inputs)).await;
        let job = running_job_by_id(&ctx, &id).unwrap_or(job);
        Ok(json!({"job": job}))
    }
}
