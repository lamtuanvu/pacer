//! Idle-work blockers, mirroring `src/update/desktop/blockers.ts` and the
//! closure proof from `src/update/desktop/orca-proof.ts`.
//!
//! Only raw persisted evidence is used here; nothing launches or mutates
//! side effects. A missing or malformed record stays a recovery blocker, so
//! it can never prove idle.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

/// A reason desktop work is not idle. `kind` matches the TS union
/// `task | session | launch | operation`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blocker {
    pub kind: String,
    pub id: String,
    pub label: String,
}

impl Blocker {
    pub fn new(kind: &str, id: String, label: String) -> Self {
        Self {
            kind: kind.to_owned(),
            id,
            label,
        }
    }
}

/// Directory entries, treating a missing directory as empty.
fn entries(path: &Path) -> Vec<PathBuf> {
    match fs::read_dir(path) {
        Ok(read) => read
            .filter_map(io::Result::ok)
            .map(|entry| entry.path())
            .collect(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(_) => Vec::new(),
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// A run has a numeric `exit` file (positive completion evidence).
pub fn run_finished(dir: &Path) -> bool {
    fs::read_to_string(dir.join("exit"))
        .ok()
        .map(|text| {
            let trimmed = text.trim();
            !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit())
        })
        .unwrap_or(false)
}

/// Task-state reasons that keep a queued task off the resume path.
const QUEUE_REASONS: &[&str] = &[
    "no_slot",
    "paused",
    "host_down",
    "waiting_retry",
    "machine_memory_pressure",
    "machine_load",
];

fn is_terminal_state(state: &str) -> bool {
    matches!(
        state,
        "done" | "partial" | "failed" | "limit" | "stopped" | "needs_input"
    )
}

/// A stored task, validated like the TS `storedTask`. `queue` reason must be
/// one of `QUEUE_REASONS`; an unsupported reason fails validation and
/// becomes a recovery blocker.
fn parse_stored_task(value: &Value) -> Option<(String, String, bool, Option<String>)> {
    let id = value.get("id")?.as_str()?.to_owned();
    let state = value.get("state")?.as_str()?.to_owned();
    if !(state == "queued" || state == "running" || is_terminal_state(&state)) {
        return None;
    }
    let brief = value.get("brief")?;
    if brief.get("goal").and_then(Value::as_str).is_none()
        || brief.get("repo").and_then(Value::as_str).is_none()
    {
        return None;
    }
    if !value.get("attempts").is_some_and(Value::is_array) {
        return None;
    }
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned);
    // `task.queue` is present when the object is non-empty; `parse_stored_task`
    // must return false when the queue reason is absent so a queued task with
    // no reason stays a blocker (matching TS `state === "queued" && !task.queue`).
    let mut has_queue = false;
    if let Some(queue) = value.get("queue") {
        if !queue.is_null() {
            let reason = value.pointer("/queue/reason").and_then(Value::as_str)?;
            if !QUEUE_REASONS.contains(&reason) {
                return None;
            }
            let since = value.pointer("/queue/since").and_then(Value::as_f64)?;
            let position = value.pointer("/queue/position").and_then(Value::as_i64)?;
            if !since.is_finite() || position <= 0 {
                return None;
            }
            has_queue = true;
        }
    }
    Some((id, state, has_queue, title))
}

/// A stored operation job, validated like the TS `storedJob`. Returns
/// `(id, kind, state)` so a caller can label with the operation kind.
fn parse_stored_job(value: &Value) -> Option<(String, String, String)> {
    let id = value.get("id")?.as_str()?.to_owned();
    let kind = value.get("kind")?.as_str()?.to_owned();
    if !matches!(
        kind.as_str(),
        "host.check" | "runner.check" | "host.repo.setup" | "host.clean" | "update.apply"
    ) {
        return None;
    }
    let state = value.get("state")?.as_str()?.to_owned();
    if !matches!(
        state.as_str(),
        "running" | "passed" | "failed" | "cancelled"
    ) {
        return None;
    }
    if value.get("pid").and_then(Value::as_i64).unwrap_or(0) <= 0 {
        return None;
    }
    let started_at = value.get("startedAt").and_then(Value::as_f64)?;
    if !started_at.is_finite() {
        return None;
    }
    if !value.get("steps").is_some_and(Value::is_array) {
        return None;
    }
    Some((id, kind, state))
}

/// Raw persisted task, run and job evidence. A malformed or unsupported
/// record becomes a recovery blocker so it can never prove idle.
pub fn stored_blockers(home: &Path) -> Vec<Blocker> {
    let mut blockers = Vec::new();
    // Tasks: mirror `storedBlockers` in `blockers.ts`. A valid record blocks
    // only while running or queued without a queue reason; a queued task with
    // a reason, or a settled/terminal state, is not a blocker. Anything that
    // does not decode as a stored task needs recovery.
    for name in entries(&home.join("tasks")) {
        if name.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let id = file_stem(&name);
        let parsed = read_json(&name).and_then(|value| parse_stored_task(&value));
        match parsed {
            // A valid record blocks only while running, or queued with no
            // queue reason (TS: `state === "running" || (state === "queued"
            // && !task.queue)`). A queued task with a reason, or a settled
            // terminal state, leaves the gate open.
            Some((task_id, state, has_queue, title)) if task_id == id => {
                if state == "running" || (state == "queued" && !has_queue) {
                    blockers.push(task_blocker(&id, title.as_deref()));
                }
            }
            _ => blockers.push(Blocker {
                kind: "task".to_owned(),
                id,
                label: "Task state needs recovery".to_string(),
            }),
        }
    }
    // Runs: a surviving PID or session marks an unclosed run until a
    // completion receipt is available. A missing PID query is not proof of
    // completion.
    for task in entries(&home.join("runs")) {
        let task_name = file_name(&task);
        let root = home.join("runs").join(&task);
        for attempt in entries(&root) {
            let dir = root.join(&attempt);
            if run_finished(&dir) {
                continue;
            }
            if dir.join("pid").exists() || dir.join("session.json").exists() {
                let attempt_name = file_name(&attempt);
                blockers.push(Blocker {
                    kind: "session".to_owned(),
                    id: format!("{task_name}/{attempt_name}"),
                    label: format!("Session {task_name}"),
                });
            }
        }
    }
    // Jobs: mirror `storedBlockers` in `blockers.ts`. A running operation
    // blocks (labelled with its kind); a valid settled job is not a blocker;
    // anything that does not decode as a stored job needs recovery.
    for name in entries(&home.join("state").join("jobs")) {
        if name.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let id = file_stem(&name);
        match read_json(&name).and_then(|value| parse_stored_job(&value)) {
            Some((job_id, kind, state)) if job_id == id && state == "running" => {
                blockers.push(Blocker {
                    kind: "operation".to_owned(),
                    id,
                    label: kind,
                });
            }
            // A valid, settled operation leaves the gate open.
            Some((job_id, _, _)) if job_id == id => {}
            _ => blockers.push(Blocker {
                kind: "operation".to_owned(),
                id,
                label: "Operation state needs recovery".to_string(),
            }),
        }
    }
    blockers
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned()
}

/// Closure judgement for a terminal, matching `terminalClosureProof` in
/// `src/update/desktop/orca-proof.ts`: only an explicit closed state with the
/// exact handle and incarnation proves the terminal ended.
pub fn terminal_closure_proof(reply: &Value, handle: &str, incarnation_id: &str) -> bool {
    if incarnation_id.is_empty() {
        return false;
    }
    let Some(ok) = reply.get("ok").and_then(Value::as_bool) else {
        return false;
    };
    if !ok {
        return false;
    }
    let Some(terminal) = reply.pointer("/result/terminal") else {
        return false;
    };
    if terminal.get("handle").and_then(Value::as_str) != Some(handle) {
        return false;
    }
    if terminal.get("incarnationId").and_then(Value::as_str) != Some(incarnation_id) {
        return false;
    }
    // TS requires an explicit `false` on both flags (`=== false`); anything
    // else — `true`, absent, or null — is not positive closure evidence and
    // must fail closed.
    if terminal.get("connected").and_then(Value::as_bool) != Some(false)
        || terminal.get("writable").and_then(Value::as_bool) != Some(false)
    {
        return false;
    }
    terminal.pointer("/exitCause/kind").and_then(Value::as_str) == Some("operator_close")
}

/// Probes whether an Orca worker's terminal has ended. `worker` is the
/// terminal handle. Production uses the Orca CLI with a bounded deadline.
pub trait OrcaProbe {
    /// True only when positive closure evidence is available for `worker`.
    fn closed(&self, worker: &str) -> bool;
}

/// Production probe bound to a specific terminal handle and incarnation:
/// runs `orca terminal show --terminal <handle> --json` with a 2 s deadline
/// and applies `terminal_closure_proof`. A missing/broken CLI or an
/// unavailable host stays open (a blocker).
pub struct OrcaCliProbe {
    handle: String,
    incarnation: String,
    argv0: String,
    deadline: Duration,
}

impl OrcaCliProbe {
    pub fn new(handle: String, incarnation: String, orcabin: &str, deadline: Duration) -> Self {
        Self {
            handle,
            incarnation,
            argv0: orcabin.to_owned(),
            deadline,
        }
    }
}

impl OrcaProbe for OrcaCliProbe {
    fn closed(&self, worker: &str) -> bool {
        if worker != self.handle {
            return false;
        }
        let Some(output) = run_bounded(
            &self.argv0,
            &["terminal", "show", "--terminal", &self.handle, "--json"],
            self.deadline,
        ) else {
            // A missing/broken CLI, an unavailable host, or a probe that
            // exceeded its deadline stays open (a blocker).
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let Ok(reply) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&output.stdout))
        else {
            return false;
        };
        terminal_closure_proof(&reply, &self.handle, &self.incarnation)
    }
}

/// Run `argv0` with `args`, bounded by `deadline`. Returns `None` when the
/// child cannot be spawned, does not exit in time (and is killed), or its
/// output streams cannot be read. A zero deadline falls back to an unbounded
/// wait so a disabled time bound cannot make the probe fail spuriously.
fn run_bounded(argv0: &str, args: &[&str], deadline: Duration) -> Option<std::process::Output> {
    let mut child = Command::new(argv0)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(status) => {
                let stdout = child.wait_with_output().ok()?.stdout;
                return Some(std::process::Output {
                    status,
                    stdout,
                    stderr: Vec::new(),
                });
            }
            None => {
                if !deadline.is_zero() && start.elapsed() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                // Poll the child rather than sleeping for the full remaining
                // budget: a fast exit must not be delayed by the deadline.
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

/// External Orca blockers from `orca.json`. `new_probe` binds a terminal
/// handle (and incarnation) to a probe used to test closure. Malformed Orca
/// state becomes a recovery blocker.
pub fn external_blockers(
    home: &Path,
    new_probe: &dyn for<'p> Fn(&'p str, &'p str) -> Box<dyn OrcaProbe + 'p>,
) -> Vec<Blocker> {
    let path = home.join("orca.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return vec![recovery("session", "orca", "Orca state needs recovery")],
    };
    let Some(workers) = value.get("workers").and_then(Value::as_object) else {
        return vec![recovery("session", "orca", "Orca state needs recovery")];
    };
    if value.get("coordinator").and_then(Value::as_str).is_none()
        || value.get("run").and_then(Value::as_str).is_none()
    {
        return vec![recovery("session", "orca", "Orca state needs recovery")];
    }
    let mut blockers = Vec::new();
    for (id, worker) in workers {
        let Some(dispatch_id) = worker.get("dispatchId").and_then(Value::as_str) else {
            return vec![recovery("session", "orca", "Orca state needs recovery")];
        };
        let task_id = worker.get("taskId").and_then(Value::as_str);
        let executor = worker.get("executor").and_then(Value::as_str);
        let worktree = worker.get("worktree");
        let _ = worktree;
        let _ = executor;
        if !dispatch_id.is_empty() || task_id.is_some() {
            // Validate the worker row roughly; an invalid worker row is a
            // recovery blocker, matching the TS zod parse.
            if worker_ok(worker) {
                if worker.get("terminal").and_then(Value::as_str).is_some() {
                    if worker
                        .get("incarnationId")
                        .and_then(Value::as_str)
                        .is_none()
                    {
                        blockers.push(recovery("session", &id, "Orca session"));
                        continue;
                    }
                }
            } else {
                blockers.push(recovery_entry(worker, id));
            }
        }
        let mut ended = false;
        if let Some(terminal) = worker.get("terminal").and_then(Value::as_str) {
            let incarnation = worker
                .get("incarnationId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let probe = new_probe(terminal, incarnation);
            ended = probe.closed(terminal);
        }
        if !ended {
            let task = worker.get("taskId").and_then(Value::as_str).unwrap_or(id);
            blockers.push(Blocker {
                kind: "session".to_owned(),
                id: task.to_owned(),
                label: "Orca session".to_owned(),
            });
        }
    }
    blockers
}

fn worker_ok(worker: &Value) -> bool {
    worker
        .get("dispatchId")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        && worker
            .get("taskId")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        && worker
            .get("executor")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        && worker
            .get("startedAt")
            .and_then(Value::as_f64)
            .is_some_and(|v| v.is_finite())
}

fn recovery_entry(worker: &Value, fallback_id: &str) -> Blocker {
    let id = worker
        .get("taskId")
        .and_then(Value::as_str)
        .unwrap_or(fallback_id)
        .to_owned();
    recovery("session", &id, "Orca state needs recovery")
}

fn recovery(kind: &str, id: &str, label: &str) -> Blocker {
    Blocker {
        kind: kind.to_owned(),
        id: id.to_owned(),
        label: label.to_owned(),
    }
}

/// A task blocker labelled with the task's title (like TS `task.title ?? id`).
fn task_blocker(id: &str, title: Option<&str>) -> Blocker {
    Blocker {
        kind: "task".to_owned(),
        id: id.to_owned(),
        label: title.filter(|t| !t.is_empty()).unwrap_or(id).to_owned(),
    }
}
