use crate::{
    AdmissionError, AdmissionState, SlotLimits, queue_capacity, slot_use,
    state::{dependencies, get_work},
};
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::WireReply;
use pacer_store::{StoreError, TaskEdit, TaskFilter};
use serde_json::{Value, json};

/// Already ranked, project/policy-authorized route and local exclusion snapshot.
/// Remote eligibility and plugin I/O finish before the slots lock is acquired.
#[derive(Clone)]
pub struct DrainRoute {
    pub executor: String,
    pub host: Option<String>,
    pub limits: SlotLimits,
    pub machine_guard: Option<Value>,
    pub excluded: bool,
}
impl DrainRoute {
    pub fn local(executor: &str, max: usize) -> Self {
        Self {
            executor: executor.into(),
            host: None,
            limits: SlotLimits {
                executor: max,
                host: None,
                local: None,
            },
            machine_guard: None,
            excluded: false,
        }
    }
}
fn refreshable(queue: &Value) -> bool {
    ["no_slot", "machine_memory_pressure", "machine_load"]
        .iter()
        .any(|r| queue["reason"] == *r)
        || (queue["reason"] == "waiting_retry"
            && queue["limit"] == "machine"
            && queue["detail"] == "Waiting for an available executor")
}
fn remove(task: &mut TaskEdit, key: &str) -> Result<(), StoreError> {
    let path = format!("/{key}");
    if task.preview().get(key).is_some() {
        task.remove(&path)?;
    }
    Ok(())
}
// Value indexing previously created an object from a missing/null queue.
fn queue_put(task: &mut TaskEdit, key: &str, value: Value) -> Result<(), StoreError> {
    if task.preview().get("queue").is_none_or(Value::is_null) {
        task.put("/queue", WireReply::new(json!({})))?;
    }
    task.put(&format!("/queue/{key}"), WireReply::new(value))
}
fn replace_capacity_queue(task: &mut TaskEdit, next: Value) -> Result<(), StoreError> {
    let mut next = WireReply::new(next);
    for key in ["since", "position"] {
        let path = format!("/queue/{key}");
        let value = if task.preview().pointer(&path).is_some() {
            task.subtree(&path)?
        } else {
            WireReply::new(Value::Null)
        };
        next.put(&format!("/{key}"), value)?;
    }
    task.put("/queue", next)
}
impl AdmissionState {
    /// Explicit supervisor action. Read APIs call neither this nor its launcher.
    /// A shared drain lock serializes launch/rollback; SQLite IMMEDIATE protects
    /// capacity against other Rust and Bun writers under the shared slots lock.
    pub fn drain(
        &mut self,
        now: f64,
        paused: bool,
        mut authorize: impl FnMut(&Value) -> Result<Vec<DrainRoute>, AdmissionError>,
        mut launch: impl FnMut(&Value) -> Result<Option<u32>, AdmissionError>,
    ) -> Result<Vec<String>, AdmissionError> {
        self.drain_with_options(
            now,
            DrainOptions {
                paused,
                ..Default::default()
            },
            |task| authorize(task).map(RouteAdmission::unrestricted),
            &mut launch,
        )
    }
    pub fn drain_admitted<'a>(
        &mut self,
        now: f64,
        paused: bool,
        mut authorize: impl FnMut(&Value) -> Result<RouteAdmission<'a>, AdmissionError>,
        mut launch: impl FnMut(&Value) -> Result<Option<u32>, AdmissionError>,
    ) -> Result<Vec<String>, AdmissionError> {
        self.drain_with_options(
            now,
            DrainOptions {
                paused,
                policy_plugins: 1,
                ..Default::default()
            },
            &mut authorize,
            &mut launch,
        )
    }
    pub fn drain_with_options<'a>(
        &mut self,
        now: f64,
        options: DrainOptions,
        mut authorize: impl FnMut(&Value) -> Result<RouteAdmission<'a>, AdmissionError>,
        mut launch: impl FnMut(&Value) -> Result<Option<u32>, AdmissionError>,
    ) -> Result<Vec<String>, AdmissionError> {
        self.drain_checked(now, options, |_| Ok(None), &mut authorize, &mut launch)
    }
    /// Current repository/project and requested-runner checks precede pause and
    /// route policy. A terminal preflight result never invokes policy or launch.
    pub fn drain_checked<'a>(
        &mut self,
        now: f64,
        options: DrainOptions,
        mut preflight: impl FnMut(&Value) -> Result<Option<Value>, AdmissionError>,
        mut authorize: impl FnMut(&Value) -> Result<RouteAdmission<'a>, AdmissionError>,
        mut launch: impl FnMut(&Value) -> Result<Option<u32>, AdmissionError>,
    ) -> Result<Vec<String>, AdmissionError> {
        if options.read_only {
            return Ok(vec![]);
        }
        let home = self.tasks.home_path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home, Default::default(), now);
        with_lock(&ctx, "drain", LockOptions::default(), || {
            self.drain_locked(
                &ctx,
                now,
                options,
                &mut preflight,
                &mut authorize,
                &mut launch,
            )
        })?
    }
    fn drain_locked<'a>(
        &mut self,
        ctx: &Ctx,
        now: f64,
        options: DrainOptions,
        preflight: &mut impl FnMut(&Value) -> Result<Option<Value>, AdmissionError>,
        authorize: &mut impl FnMut(&Value) -> Result<RouteAdmission<'a>, AdmissionError>,
        launch: &mut impl FnMut(&Value) -> Result<Option<u32>, AdmissionError>,
    ) -> Result<Vec<String>, AdmissionError> {
        let mut waiting = self.tasks.list(&TaskFilter {
            states: Some(&["queued"]),
            ..Default::default()
        })?;
        waiting.retain(|t| t.get("queue").is_some());
        let mut ranked = Vec::new();
        for t in waiting {
            let priority = self
                .work(t["id"].as_str().unwrap_or(""))?
                .and_then(|w| w["options"]["priority"].as_f64())
                .unwrap_or(0.0);
            ranked.push((t, priority));
        }
        ranked.sort_by(|(a, ap), (b, bp)| {
            bp.total_cmp(ap)
                .then_with(|| {
                    a["createdAt"]
                        .as_f64()
                        .unwrap_or(0.0)
                        .total_cmp(&b["createdAt"].as_f64().unwrap_or(0.0))
                })
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        let mut spawned = Vec::new();
        let mut budget = std::time::Duration::from_secs(10);
        for (task, _) in ranked {
            if options.policy_plugins > 0 && budget.is_zero() {
                break;
            }
            let id = task["id"]
                .as_str()
                .ok_or_else(|| AdmissionError("Invalid task id".into()))?;
            let rev = task["rev"].as_i64().unwrap_or(1);
            if self.work(id)?.is_some_and(|w| {
                w["options"]["expiresAt"]
                    .as_f64()
                    .is_some_and(|at| at <= now)
            }) {
                expire_task(&mut self.tasks, id, now)?;
                continue;
            }
            if task["queue"]["nextAt"].as_f64().is_some_and(|at| at > now)
                || !self.pending_dependencies(id)?.is_empty()
            {
                continue;
            }
            let failure = match preflight(&task) {
                Ok(result) => result,
                Err(error) if error.is_conflict() => continue,
                Err(error) => Some(failed_result(None, error.to_string())),
            };
            if let Some(result) = failure {
                match self.tasks.edit(id, rev, now, |t| {
                    t.put("/state", WireReply::new(json!("failed")))?;
                    remove(t, "queue")?;
                    t.put("/result", WireReply::new(result))
                }) {
                    Ok(_) | Err(StoreError::Conflict) => {}
                    Err(error) => return Err(error.into()),
                }
                continue;
            }
            if options.paused || read_pause(ctx) {
                continue;
            }
            let started = std::time::Instant::now();
            let authorized = authorize(&task);
            budget = budget.saturating_sub(started.elapsed());
            let mut admission = match authorized {
                Ok(receipt) => receipt,
                Err(error) => {
                    if !error.is_conflict() {
                        let detail = format!("Route policy: {error}");
                        match self.tasks.edit(id, rev, now, |t| {
                            queue_put(t, "reason", json!("waiting_retry"))?;
                            queue_put(
                                t,
                                "detail",
                                json!(detail.chars().take(500).collect::<String>()),
                            )?;
                            queue_put(t, "nextAt", json!(now + 30.0))
                        }) {
                            Ok(_) | Err(StoreError::Conflict) => {}
                            Err(error) => return Err(error.into()),
                        }
                    }
                    continue;
                }
            };
            let launched = with_lock(
                ctx,
                "slots",
                LockOptions::default(),
                || -> Result<bool, AdmissionError> {
                    let reservation =
                        with_lock(ctx, "project-strategies", LockOptions::default(), || {
                            reserve(
                                &mut self.tasks,
                                ctx,
                                id,
                                rev,
                                now,
                                options.paused,
                                &mut admission,
                            )
                        })?;
                    let (selected, prior_queue) = match reservation {
                        Ok(t) => t,
                        Err(StoreError::Conflict | StoreError::Unchanged) => return Ok(false),
                        Err(StoreError::Admission(ref message))
                            if message.starts_with("conflict:") =>
                        {
                            return Ok(false);
                        }
                        Err(error) => return Err(error.into()),
                    };
                    if selected.preview()["state"] != "running" {
                        return Ok(false);
                    }
                    let selected_rev = selected.preview()["rev"].as_i64().unwrap_or(1);
                    match launch(selected.preview()) {
                        Ok(pid) => {
                            self.tasks.edit(id, selected_rev, now, |t| {
                                if let Some(pid) = pid {
                                    t.put("/runnerPid", WireReply::new(json!(pid)))
                                } else {
                                    remove(t, "runnerPid")
                                }
                            })?;
                            Ok(true)
                        }
                        Err(error) => {
                            self.tasks.edit(id, selected_rev, now, |t| {
                                t.put("/state", WireReply::new(json!("queued")))?;
                                t.put("/queue", prior_queue)?;
                                remove(t, "executor")?;
                                remove(t, "runnerPid")
                            })?;
                            Err(error)
                        }
                    }
                },
            )??;
            if launched {
                spawned.push(id.to_owned());
            }
        }
        let mut remaining = self.tasks.list(&TaskFilter {
            states: Some(&["queued"]),
            ..Default::default()
        })?;
        remaining.retain(|t| t.get("queue").is_some());
        remaining.sort_by(|a, b| {
            a["createdAt"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b["createdAt"].as_f64().unwrap_or(0.0))
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        update_positions(&mut self.tasks, &remaining, now)?;
        Ok(spawned)
    }
}

fn expire_task(
    store: &mut pacer_store::TaskStore,
    id: &str,
    now: f64,
) -> Result<(), AdmissionError> {
    match store.edit_current(id, now, |current| {
        if current.preview()["state"] != "queued" || current.preview().get("queue").is_none() {
            return Err(StoreError::Unchanged);
        }
        current.put("/state", WireReply::new(json!("failed")))?;
        remove(current, "queue")?;
        current.put(
            "/result",
            WireReply::new(failed_result(None, "Work dispatch deadline expired".into())),
        )
    }) {
        Ok(_) | Err(StoreError::Conflict | StoreError::Unchanged | StoreError::UnknownTask(_)) => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn update_positions(
    store: &mut pacer_store::TaskStore,
    remaining: &[Value],
    now: f64,
) -> Result<(), AdmissionError> {
    for (index, t) in remaining.iter().enumerate() {
        match store.edit_current(t["id"].as_str().unwrap_or(""), now, |current| {
            if current.preview().get("queue").is_none() {
                return Err(StoreError::Unchanged);
            }
            queue_put(current, "position", json!(index + 1))
        }) {
            Ok(_)
            | Err(StoreError::Conflict | StoreError::Unchanged | StoreError::UnknownTask(_)) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

/// A completed route policy receipt. The host guard rechecks policy registration,
/// strategy/project revisions, repo identity, exclusions and operation lifetime
/// under slots + project-strategies + SQLite writer locks, before any mutation.
pub struct RouteAdmission<'a> {
    pub routes: Vec<DrainRoute>,
    pub project_limited: bool,
    pub excluded_detail: String,
    pub revalidate: Box<RouteGuard<'a>>,
}
pub type RouteGuard<'a> =
    dyn FnMut(&rusqlite::Connection, &Value) -> Result<(), AdmissionError> + 'a;
impl RouteAdmission<'_> {
    pub fn unrestricted(routes: Vec<DrainRoute>) -> Self {
        Self {
            routes,
            project_limited: false,
            excluded_detail: "no choices passed the routing filter".into(),
            revalidate: Box::new(|_, _| Ok(())),
        }
    }
}

fn reserve(
    store: &mut pacer_store::TaskStore,
    ctx: &Ctx,
    id: &str,
    rev: i64,
    now: f64,
    paused: bool,
    admission: &mut RouteAdmission<'_>,
) -> Result<(WireReply, WireReply), StoreError> {
    let mut prior_queue = WireReply::new(Value::Null);
    let selected = store.edit_admitted(id, rev, now, |db, current| {
        let fail = |e: AdmissionError| StoreError::Admission(e.0);
        if current.preview()["state"] != "queued" || current.preview().get("queue").is_none()
            || !dependencies(db, id).map_err(fail)?.is_empty()
            || get_work(db, id).map_err(fail)?.is_some_and(|w| {
                w["options"]["expiresAt"].as_f64().is_some_and(|at| at <= now)
            }) { return Err(StoreError::Conflict); }
        (admission.revalidate)(db, current.preview()).map_err(fail)?;
        if paused || read_pause(ctx) { return Err(StoreError::Unchanged); }
        // Capture from this CAS-checked transaction, never the earlier list preview.
        prior_queue = current.subtree("/queue")?;
        if admission.project_limited && admission.routes.is_empty()
            && current.preview()["interactionMode"] != "conversation" {
            current.put("/state", WireReply::new(json!("limit")))?;
            remove(current, "queue")?;
            current.put("/result", WireReply::new(json!({"status":"limit","executor":null,"model":null,"files":"",
                "report":format!("no project executor available ({})",admission.excluded_detail),"backend":"direct"})))?;
            return Ok(());
        }
        let mut statement = db.prepare("SELECT record FROM tasks WHERE state IN ('running','needs_input')")?;
        let records = statement.query_map([], |r| r.get::<_,String>(0))?
            .collect::<Result<Vec<_>,_>>()?;
        // These previews are only inputs to capacity counting, never stored-value sources.
        let tasks = records.iter().map(|s| WireReply::parse(s).map(|wire| wire.preview().clone())).collect::<Result<Vec<_>,_>>()?;
        let use_ = slot_use(&tasks);
        let requested = current.preview()["requestedExecutor"].as_str().filter(|s| !s.is_empty());
        let eligible: Vec<_> = admission.routes.iter().filter(|r| !r.excluded
            && requested.is_none_or(|id| id == r.executor)).collect();
        let capacity = |route: &&DrainRoute| queue_capacity(&route.executor, route.host.as_deref(),
            route.limits, &use_, route.machine_guard.clone());
        let before = current.preview().clone();
        if let Some(route) = eligible.iter().find(|route| capacity(route).is_none()) {
            current.put("/state", WireReply::new(json!("running")))?;
            current.put("/executor", WireReply::new(json!(route.executor)))?;
            remove(current,"queue")?;
            remove(current,"runnerPid")?;
        } else if refreshable(&current.preview()["queue"]) {
            if let Some(next) = eligible.first().and_then(capacity) {
                replace_capacity_queue(current, next)?;
            } else if current.preview()["queue"]["reason"].as_str().is_some_and(|s| s.starts_with("machine_")) {
                replace_capacity_queue(current, json!({"reason":"waiting_retry","limit":"machine",
                    "detail":"Waiting for an available executor"}))?;
            }
        }
        // Keep the existing preview/numeric/object-order no-op rule, but an
        // explicit fresh string must not equal a different UTF-16 sequence.
        if current.preview() == &before
            && crate::json::Value::parse(&prior_queue.to_json()?).map_err(fail)?
                == crate::json::Value::parse(&current.subtree("/queue")?.to_json()?).map_err(fail)? {
            return Err(StoreError::Unchanged);
        }
        Ok(())
    })?;
    Ok((selected, prior_queue))
}

/// Same validation as core/pause.ts. Missing or malformed state is unpaused.
fn read_pause(ctx: &Ctx) -> bool {
    use crate::json::Value as PauseValue;
    let Ok(text) = std::fs::read_to_string(ctx.pacer_home.join("state/pause.json")) else {
        return false;
    };
    let Ok(state) = PauseValue::parse(&text) else {
        return false;
    };
    let valid_text = |key| {
        state
            .get(key)
            .is_some_and(|v| matches!(v, PauseValue::Null | PauseValue::String(_)))
    };
    state.get("until").is_some_and(|v| {
        matches!(v, PauseValue::Null) || v.as_f64().is_some_and(|n| n.is_finite() && n > ctx.now)
    }) && valid_text("reason")
        && valid_text("by")
}

#[derive(Clone, Copy, Default)]
pub struct DrainOptions {
    pub paused: bool,
    pub read_only: bool,
    pub policy_plugins: usize,
}

/// The pre-policy checks in drainQueue. A removed requested runner and an
/// unavailable project identity terminate queued work even while paused.
pub fn queue_preflight(
    strategy: &Value,
    projects: &Value,
    repo: &Value,
    task: &Value,
) -> Result<Option<Value>, AdmissionError> {
    let projects = crate::validate_project_strategies(projects)?;
    let strict = projects["projects"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .any(|p| !p["executors"].is_null());
    if strict
        && (repo["identityUnverified"] == true || repo["key"].as_str().is_none_or(str::is_empty))
    {
        return Err(AdmissionError(
            "Cannot establish repository identity for project routing".into(),
        ));
    }
    let requested = task["requestedExecutor"].as_str().filter(|s| !s.is_empty());
    if let Some(selection) =
        crate::project_selection(strategy, repo["key"].as_str().unwrap_or(""), &projects)
        && let Some(id) = requested
        && !selection["executors"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|value| value == id))
    {
        return Err(AdmissionError(format!(
            "{id} is forbidden by project policy for {}",
            repo["key"].as_str().unwrap_or("")
        )));
    }
    if let Some(id) = requested
        && crate::resolve_runner(strategy, id).is_none()
    {
        return Ok(Some(failed_result(
            Some(id),
            format!("{id} was removed while the task waited"),
        )));
    }
    Ok(None)
}
fn failed_result(executor: Option<&str>, report: String) -> Value {
    json!({"status":"failed","executor":executor,"model":null,"files":"","report":report,"backend":"direct"})
}
