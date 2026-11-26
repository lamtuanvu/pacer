//! Port of `directInputAvailable` and `sendDirectInput` (`src/session/send.ts`).
//! The only runtime effect is the session socket client, injected by `pacer-sessions`.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_sessions::client::{TypeResult, type_into_session};
use pacer_store::TaskStore;
use serde_json::Value;
use std::{path::PathBuf, process::Command};

fn number(dir: &std::path::Path, name: &str) -> Option<f64> {
    std::fs::read_to_string(dir.join(name))
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
}

/// `readRun(dir).alive` from `src/supervisor/run.ts`: pid alive and still this run's wrapper.
fn run_alive(dir: &std::path::Path) -> bool {
    let Some(pid) = number(dir, "pid") else {
        return false;
    };
    if Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .output()
        .is_err()
    {
        return false;
    }
    let Ok(out) = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let command = String::from_utf8_lossy(&out.stdout);
    let command = command.trim();
    command.contains(&dir.join("run.sh").to_string_lossy().into_owned())
        || command.ends_with(&format!("_session {}", dir.display()))
}

fn session_socket(dir: &std::path::Path) -> PathBuf {
    std::fs::read_to_string(dir.join("session.sock.path"))
        .ok()
        .map(|s| PathBuf::from(s.trim()))
        .unwrap_or_else(|| dir.join("session.sock"))
}

/// Built-in PTYs prove liveness from the owned run, not an Orca worker record.
pub fn direct_input_available(task: &Value) -> bool {
    if task.get("state").and_then(Value::as_str) != Some("running") {
        return false;
    }
    let Some(run) = task.get("run") else {
        return false;
    };
    if !run.get("host").map_or(true, Value::is_null) || run.get("takeover").is_some() {
        return false;
    }
    let Some(dir) = run.get("dir").and_then(Value::as_str) else {
        return false;
    };
    let dir = std::path::Path::new(dir);
    if !dir.join("interactive.json").exists() || number(dir, "exit").is_some() {
        return false;
    }
    run_alive(dir)
}

/// Session-supplied labels and reasons are untrusted: strip terminal controls.
fn clean(label: &str) -> String {
    label.chars().filter(|c| !c.is_control()).collect()
}

/// Roll back a definite refusal: nothing reached the PTY, so the question is open again.
fn rollback(ctx: &Ctx, task: &Value, text: &str, guard: &impl Fn(&Value) -> bool) {
    let id = task["id"].as_str().unwrap_or_default();
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return;
    };
    let _ = store.update_current(id, ctx.now, |t| {
        if guard(t)
            && t.get("question")
                .and_then(|q| q.get("answer"))
                .and_then(Value::as_str)
                == Some(text)
            && let Some(q) = t.get_mut("question").and_then(Value::as_object_mut)
        {
            q.remove("answer");
            q.remove("answeredAt");
        }
        Ok(())
    });
}

/// Type `text` into the task's live run while `guard` still holds.
pub async fn send_direct_input(
    ctx: &Ctx,
    task: &Value,
    text: &str,
    guard: impl Fn(&Value) -> bool,
) -> Result<(), CoreError> {
    let Some(dir) = task
        .get("run")
        .and_then(|r| r.get("dir"))
        .and_then(Value::as_str)
    else {
        return Err(CoreError::new(Code::Unavailable, "No interactive run"));
    };
    let dir = std::path::Path::new(dir);
    let still_idle = || {
        let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
            return false;
        };
        let Ok(Some(current)) = store.read(&task["id"].as_str().unwrap_or_default()) else {
            return false;
        };
        current.get("run").and_then(|r| r.get("dir")).and_then(Value::as_str) == Some(dir.to_str().unwrap_or_default())
            && direct_input_available(&current)
            && guard(&current)
    };
    match type_into_session(&session_socket(dir), text, still_idle).await {
        Ok(TypeResult::Typed) => Ok(()),
        Ok(TypeResult::Refused { controller }) => {
            rollback(ctx, task, text, &guard);
            let label = clean(
                &controller
                    .map(|c| c.split(':').last().unwrap_or(&c).to_owned())
                    .unwrap_or_else(|| "another viewer".into()),
            );
            Err(CoreError::new(
                Code::Conflict,
                format!("The terminal is controlled from {label}; nothing was typed"),
            ))
        }
        Ok(TypeResult::Pending { reason }) => {
            rollback(ctx, task, text, &guard);
            Err(CoreError::new(
                Code::Conflict,
                format!("Not delivered: {}. Nothing was typed; try again", clean(&reason)),
            ))
        }
        Ok(TypeResult::Busy) => {
            rollback(ctx, task, text, &guard);
            Err(CoreError::new(
                Code::Conflict,
                "The task's run or question changed before delivery; nothing was typed",
            ))
        }
        Err(error) => {
            // A socket error after a write is ambiguous: keep the reservation so it is
            // never silently retyped. A definite failure before any write rolls back.
            if !error.input_attempted {
                rollback(ctx, task, text, &guard);
            }
            Err(CoreError::new(
                Code::Unavailable,
                format!("Interactive input failed: Error: Error: {}", error.message),
            ))
        }
    }
}
