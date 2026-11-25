//! Strict parsing of the `executor.run` request (M3 C5).
//!
//! Port of the zod `runInput` schema in `plugins/pacer-exec-orca/index.ts:6-11`.
//! The shape and bounds match the TypeScript SDK exactly: `task` must carry
//! `id` and a positive safe `rev`, `attempt` a positive safe integer, `runDir`
//! the literal `1`, and `orca` an `executor` of 1–256 UTF-16 units, a `model`
//! that is `null` or a string of at most 256 UTF-16 units, a positive
//! `timeoutMs` of at most 1,800,000, and an optional `session` that must be
//! exactly `"interactive"`. Unknown keys are rejected at every level.

use pacer_plugin::js::{safe_integer, utf16_len};
use serde_json::{Map, Value};

/// `task { id: string, rev: positive safe int }`.
pub struct Task {
    pub id: String,
    pub rev: i64,
}

/// `orca { executor: 1-256 UTF-16 units, model: null or ≤ 256 UTF-16 units,
/// timeoutMs: positive ≤ 1_800_000, session?: "interactive" }`.
pub struct Orca {
    pub executor: String,
    pub model: Option<String>,
    pub timeout_ms: i64,
    pub session: Option<String>,
}

/// The parsed `executor.run` input. `runDir` is validated as the literal `1`
/// and not carried.
pub struct RunInput {
    pub task: Task,
    pub attempt: i64,
    pub orca: Orca,
}

/// The largest `timeoutMs` zod allows (`30 * 60 * 1000`).
const MAX_TIMEOUT_MS: i64 = 1_800_000;

fn object(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// True when `obj` has exactly `keys` and no other entry.
pub(crate) fn keys_are_exactly(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    obj.len() == keys.len() && keys.iter().all(|k| obj.contains_key(*k))
}

fn parse_task(v: &Value) -> Option<Task> {
    let obj = object(v)?;
    if !keys_are_exactly(obj, &["id", "rev"]) {
        return None;
    }
    let id = obj.get("id")?.as_str()?.to_owned();
    let rev = safe_integer(obj.get("rev")?)?;
    if rev <= 0 {
        return None;
    }
    Some(Task { id, rev })
}

fn parse_orca(v: &Value) -> Option<Orca> {
    let obj = object(v)?;
    // `session` is optional; the key set is the three required plus `session`.
    if !keys_are_exactly(obj, &["executor", "model", "timeoutMs", "session"])
        && !keys_are_exactly(obj, &["executor", "model", "timeoutMs"])
    {
        return None;
    }
    let executor = obj.get("executor")?.as_str()?;
    let executor_len = utf16_len(executor);
    if !(1..=256).contains(&executor_len) {
        return None;
    }
    let model = match obj.get("model")? {
        Value::Null => None,
        model => {
            let model = model.as_str()?;
            if utf16_len(model) > 256 {
                return None;
            }
            Some(model.to_owned())
        }
    };
    let timeout_ms = safe_integer(obj.get("timeoutMs")?)?;
    if timeout_ms <= 0 || timeout_ms > MAX_TIMEOUT_MS {
        return None;
    }
    let session = match obj.get("session") {
        None => None,
        Some(session) => {
            let session = session.as_str()?;
            if session != "interactive" {
                return None;
            }
            Some(session.to_owned())
        }
    };
    Some(Orca {
        executor: executor.to_owned(),
        model,
        timeout_ms,
        session,
    })
}

/// Parse and strictly validate the `executor.run` params, or `None` when they
/// do not describe an Orca terminal-worker attempt.
pub fn run_input(v: &Value) -> Option<RunInput> {
    let obj = object(v)?;
    if !keys_are_exactly(obj, &["task", "attempt", "runDir", "orca"]) {
        return None;
    }
    let task = parse_task(obj.get("task")?)?;
    let attempt = safe_integer(obj.get("attempt")?)?;
    if attempt <= 0 {
        return None;
    }
    let run_dir = safe_integer(obj.get("runDir")?)?;
    if run_dir != 1 {
        return None;
    }
    let orca = parse_orca(obj.get("orca")?)?;
    Some(RunInput {
        task,
        attempt,
        orca,
    })
}
