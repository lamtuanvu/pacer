//! Strict parsing of the `executor.run` request (M3 C10).
//!
//! Port of the zod `input`, `ownedInput` and `remoteInput` schemas in
//! `plugins/pacer-exec-direct/index.ts:6-38` plus the `spawnResult` schema.
//! zod 4.6.5 rules apply: `.int()` means a safe integer, `.positive()` means
//! `> 0`, and `.strict()` rejects unknown keys at every level. The three
//! shapes are tried in the dispatch order the TypeScript run handler uses:
//! remote first, then owned, then the direct effect.

use pacer_plugin::js::{finite_number, safe_integer, utf16_len};
use serde_json::{Map, Value};

/// Accepted by every shape: `task { id: string, rev: positive safe int }`.
#[derive(Clone, Debug)]
pub struct Task {
    pub id: String,
    pub rev: i64,
}

/// The direct (effect) attempt: `effect` plus the common `task`/`attempt`.
pub struct EffectRun {
    pub task: Task,
    pub attempt: i64,
    pub effect: Effect,
}

/// The owned attempt: `owned` plus the common `task`/`attempt`.
pub struct OwnedRun {
    pub task: Task,
    pub attempt: i64,
    pub owned: Owned,
}

/// The remote owned attempt: `remote` plus the common `task`/`attempt`.
pub struct RemoteRun {
    pub task: Task,
    pub attempt: i64,
    pub remote: Remote,
}

/// The parsed `executor.run` params, discriminated by which shape matched.
pub enum RunInput {
    Direct(EffectRun),
    Owned(OwnedRun),
    Remote(RemoteRun),
}

/// `effect { argv 1-32, cwd, timeoutMs ≤ 1_800_000, stdin ≤ 262144 UTF-16
/// units, env string-record, secretEnv string-record, detached? true }`.
pub struct Effect {
    pub argv: Vec<String>,
    pub cwd: String,
    pub timeout_ms: i64,
    pub stdin: Option<String>,
    pub env: Option<Map<String, Value>>,
    pub secret_env: Option<Map<String, Value>>,
    pub detached: bool,
}

/// `owned { placement current|new, session? "interactive", timeoutMs ≤
/// 14_400_000, executor 1-256, model null or ≤ 256, resume? }`.
pub struct Owned {
    pub placement: String,
    pub session: Option<String>,
    pub timeout_ms: i64,
    pub executor: String,
    pub model: Option<String>,
    pub resume: Option<OwnedResume>,
}

/// `resume { startedAt finite, logFile 1-4096, worktree? 1-4096 }`.
pub struct OwnedResume {
    pub started_at: f64,
    pub log_file: String,
    pub worktree: Option<String>,
}

/// `remote { timeoutMs ≤ 14_400_000, executor 1-256, model null or ≤ 256,
/// resume? }`.
pub struct Remote {
    pub timeout_ms: i64,
    pub executor: String,
    pub model: Option<String>,
    pub resume: Option<RemoteResume>,
}

/// `resume { startedAt finite, logFile 1-4096 }`.
pub struct RemoteResume {
    pub started_at: f64,
    pub log_file: String,
}

/// The largest `timeoutMs` zod allows for the direct effect (`30 * 60 * 1000`).
const MAX_EFFECT_TIMEOUT_MS: i64 = 1_800_000;
/// The largest `timeoutMs` zod allows for owned and remote (`240 * 60 * 1000`).
const MAX_RUN_TIMEOUT_MS: i64 = 14_400_000;
/// The largest `stdin` zod allows (UTF-16 code units).
const MAX_STDIN_UNITS: usize = 262_144;

/// True when `obj` has exactly `keys` and no other entry.
pub(crate) fn keys_are_exactly(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    obj.len() == keys.len() && keys.iter().all(|k| obj.contains_key(*k))
}

fn object(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
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

/// A string-record: map values that are all strings (`z.record(z.string(), z.string())`).
fn parse_string_record(v: &Value) -> Option<Map<String, Value>> {
    let obj = object(v)?;
    for value in obj.values() {
        if !value.is_string() {
            return None;
        }
    }
    Some(obj.clone())
}

fn parse_effect(v: &Value) -> Option<Effect> {
    let obj = object(v)?;
    // zod: `argv`, `cwd` and `timeoutMs` are required; `stdin`, `env`,
    // `secretEnv` and `detached? true` are `.optional()`. `.strict()`
    // rejects any key outside that set, so the object must be a subset of
    // the seven known keys containing the three required ones.
    const ALLOWED: [&str; 7] = ["argv", "cwd", "timeoutMs", "stdin", "env", "secretEnv", "detached"];
    for key in obj.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            return None;
        }
    }
    for required in ["argv", "cwd", "timeoutMs"] {
        if !obj.contains_key(required) {
            return None;
        }
    }
    let argv_array = obj.get("argv")?.as_array()?;
    if argv_array.is_empty() || argv_array.len() > 32 {
        return None;
    }
    let mut argv = Vec::with_capacity(argv_array.len());
    for item in argv_array {
        argv.push(item.as_str()?.to_owned());
    }
    let cwd = obj.get("cwd")?.as_str()?.to_owned();
    let timeout_ms = safe_integer(obj.get("timeoutMs")?)?;
    if timeout_ms <= 0 || timeout_ms > MAX_EFFECT_TIMEOUT_MS {
        return None;
    }
    let stdin = match obj.get("stdin") {
        None => None,
        Some(v) => {
            let s = v.as_str()?;
            if utf16_len(s) > MAX_STDIN_UNITS {
                return None;
            }
            Some(s.to_owned())
        }
    };
    let env = match obj.get("env") {
        None => None,
        Some(v) => Some(parse_string_record(v)?),
    };
    let secret_env = match obj.get("secretEnv") {
        None => None,
        Some(v) => Some(parse_string_record(v)?),
    };
    let detached = match obj.get("detached") {
        None => false,
        Some(v) => {
            if v.as_bool() != Some(true) {
                return None;
            }
            true
        }
    };
    Some(Effect {
        argv,
        cwd,
        timeout_ms,
        stdin,
        env,
        secret_env,
        detached,
    })
}

fn parse_owned_resume(v: &Value) -> Option<OwnedResume> {
    let obj = object(v)?;
    if !keys_are_exactly(obj, &["startedAt", "logFile", "worktree"])
        && !keys_are_exactly(obj, &["startedAt", "logFile"])
    {
        return None;
    }
    let started_at = finite_number(obj.get("startedAt")?)?;
    let log_file = obj.get("logFile")?.as_str()?;
    let log_len = utf16_len(log_file);
    if !(1..=4096).contains(&log_len) {
        return None;
    }
    let worktree = match obj.get("worktree") {
        None => None,
        Some(v) => {
            let s = v.as_str()?;
            if !(1..=4096).contains(&utf16_len(s)) {
                return None;
            }
            Some(s.to_owned())
        }
    };
    Some(OwnedResume {
        started_at,
        log_file: log_file.to_owned(),
        worktree,
    })
}

fn parse_owned(v: &Value) -> Option<Owned> {
    let obj = object(v)?;
    if !keys_are_exactly(
        obj,
        &["placement", "session", "timeoutMs", "executor", "model", "resume"],
    ) && !keys_are_exactly(obj, &["placement", "session", "timeoutMs", "executor", "model"])
        && !keys_are_exactly(obj, &["placement", "timeoutMs", "executor", "model", "resume"])
        && !keys_are_exactly(obj, &["placement", "timeoutMs", "executor", "model"])
    {
        return None;
    }
    let placement = obj.get("placement")?.as_str()?;
    if placement != "current" && placement != "new" {
        return None;
    }
    let session = match obj.get("session") {
        None => None,
        Some(v) => {
            let s = v.as_str()?;
            if s != "interactive" {
                return None;
            }
            Some(s.to_owned())
        }
    };
    let timeout_ms = safe_integer(obj.get("timeoutMs")?)?;
    if timeout_ms <= 0 || timeout_ms > MAX_RUN_TIMEOUT_MS {
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
    let resume = match obj.get("resume") {
        None => None,
        Some(v) => Some(parse_owned_resume(v)?),
    };
    Some(Owned {
        placement: placement.to_owned(),
        session,
        timeout_ms,
        executor: executor.to_owned(),
        model,
        resume,
    })
}

fn parse_remote_resume(v: &Value) -> Option<RemoteResume> {
    let obj = object(v)?;
    if !keys_are_exactly(obj, &["startedAt", "logFile"]) {
        return None;
    }
    let started_at = finite_number(obj.get("startedAt")?)?;
    let log_file = obj.get("logFile")?.as_str()?;
    let log_len = utf16_len(log_file);
    if !(1..=4096).contains(&log_len) {
        return None;
    }
    Some(RemoteResume {
        started_at,
        log_file: log_file.to_owned(),
    })
}

fn parse_remote(v: &Value) -> Option<Remote> {
    let obj = object(v)?;
    if !keys_are_exactly(obj, &["timeoutMs", "executor", "model", "resume"])
        && !keys_are_exactly(obj, &["timeoutMs", "executor", "model"])
    {
        return None;
    }
    let timeout_ms = safe_integer(obj.get("timeoutMs")?)?;
    if timeout_ms <= 0 || timeout_ms > MAX_RUN_TIMEOUT_MS {
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
    let resume = match obj.get("resume") {
        None => None,
        Some(v) => Some(parse_remote_resume(v)?),
    };
    Some(Remote {
        timeout_ms,
        executor: executor.to_owned(),
        model,
        resume,
    })
}

/// Parse and strictly validate the `executor.run` params, trying remote,
/// then owned, then the direct effect in dispatch order, or `None` when none
/// describe a valid attempt.
pub fn run_input(v: &Value) -> Option<RunInput> {
    let obj = object(v)?;
    if !keys_are_exactly(obj, &["task", "attempt", "runDir", "remote"])
        && !keys_are_exactly(obj, &["task", "attempt", "runDir", "owned"])
        && !keys_are_exactly(obj, &["task", "attempt", "runDir", "effect"])
    {
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

    if let Some(remote) = obj.get("remote") {
        return parse_remote(remote).map(|remote| RunInput::Remote(RemoteRun {
            task,
            attempt,
            remote,
        }));
    }
    if let Some(owned) = obj.get("owned") {
        return parse_owned(owned).map(|owned| RunInput::Owned(OwnedRun {
            task,
            attempt,
            owned,
        }));
    }
    if let Some(effect) = obj.get("effect") {
        return parse_effect(effect).map(|effect| RunInput::Direct(EffectRun {
            task,
            attempt,
            effect,
        }));
    }
    None
}

/// The rfce `z.uuid()` regex (zod 4.6.5, `node_modules/zod/v4/core/regexes.js`):
/// RFC 9562 versions 1-8, variant `[89ab]`, plus the nil and max UUIDs.
pub fn uuid_regex() -> &'static str {
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
}