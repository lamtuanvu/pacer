use super::{BrokerError, RunDirectory, denied};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::MetadataExt};
fn number(dir: &RunDirectory, name: &str) -> Result<Option<f64>, BrokerError> {
    let Some(bytes) = dir.bytes(name, usize::MAX)? else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = crate::js_semantics::trim(&text);
    if text.is_empty() {
        return Ok(None);
    }
    let value = if let Some((radix, digits)) = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .map(|s| (16, s))
        .or_else(|| {
            text.strip_prefix("0b")
                .or_else(|| text.strip_prefix("0B"))
                .map(|s| (2, s))
        })
        .or_else(|| {
            text.strip_prefix("0o")
                .or_else(|| text.strip_prefix("0O"))
                .map(|s| (8, s))
        }) {
        if digits.is_empty() {
            return Ok(None);
        }
        let mut n = 0.0;
        for c in digits.chars() {
            let Some(d) = c.to_digit(radix) else {
                return Ok(None);
            };
            n = n * f64::from(radix) + f64::from(d);
        }
        n
    } else {
        match text.parse::<f64>() {
            Ok(n) => n,
            Err(_) => return Ok(None),
        }
    };
    Ok(value.is_finite().then_some(value))
}
fn report(dir: &RunDirectory) -> Result<Value, BrokerError> {
    let conversation = dir
        .bytes("interactive.json", usize::MAX)?
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["interactionMode"] == "conversation");
    for name in if conversation {
        vec!["session-status.json"]
    } else {
        vec!["report.json", "session-status.json"]
    } {
        let Some(bytes) = dir.bytes(name, usize::MAX)? else {
            continue;
        };
        let Ok(mut r) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if !["done", "failed", "needs-input", "running", "turn-ended"]
            .contains(&r["status"].as_str().unwrap_or_default())
            || r["summary"].as_str().is_none_or(|s| {
                crate::js_semantics::trim(s).is_empty() || crate::js_semantics::utf16_len(s) > 16000
            })
            || r.get("at")
                .and_then(crate::js_semantics::finite_f64)
                .is_none()
        {
            continue;
        }
        if let Some(s) = r["summary"].as_str() {
            r["summary"] = json!(
                s.chars()
                    .filter(
                        |c| !matches!(*c,'\u{0}'..='\u{8}'|'\u{b}'..='\u{1f}'|'\u{7f}'..='\u{9f}')
                    )
                    .collect::<String>()
            );
        }
        return Ok(json!({"status":r["status"],"summary":r["summary"],"at":r["at"]}));
    }
    Ok(Value::Null)
}
pub fn read(dir: &RunDirectory) -> Result<Value, BrokerError> {
    dir.check()?;
    let pid = number(dir, "pid")?;
    let exit = number(dir, "exit")?;
    let started = number(dir, "started")?;
    let mut times = vec![];
    let mut sizes = vec![];
    for name in ["stdout", "stderr", "session.activity"] {
        let metadata = fs::metadata(dir.path.join(name)).ok();
        let size = metadata.as_ref().map_or(0, |m| m.len());
        if (name == "session.activity" || size > 0)
            && let Some(m) = metadata
        {
            times.push(m.mtime() as f64 + m.mtime_nsec() as f64 / 1e9);
        }
        sizes.push(size);
    }
    for n in [pid, exit].into_iter().flatten() {
        if n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
            return Err(denied());
        }
    }
    if pid.is_some_and(|n| n < 1.0) {
        return Err(denied());
    }
    let alive = if exit.is_none()
        && let Some(pid) = pid
            .and_then(|p| i32::try_from(p as i64).ok())
            .filter(|p| *p > 1)
    {
        let live = match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
            Ok(()) | Err(nix::errno::Errno::EPERM) => true,
            Err(_) => false,
        };
        if live {
            let out = std::process::Command::new("/bin/ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .output()
                .map_err(|_| denied())?;
            let command = String::from_utf8_lossy(&out.stdout);
            let command = crate::js_semantics::trim(&command);
            out.status.success()
                && (command.contains(&dir.path.join("run.sh").to_string_lossy().into_owned())
                    || command.ends_with(&format!("_session {}", dir.path.display())))
        } else {
            false
        }
    } else {
        false
    };
    let interactive = dir.path.join("interactive.json").exists();
    let report = if interactive {
        report(dir)?
    } else {
        Value::Null
    };
    dir.check()?;
    Ok(
        json!({"state":if exit.is_some(){"exited"}else if alive{"running"}else{"uncertain"},"pid":pid,"exitCode":exit,"startedAt":started,"stdoutBytes":sizes[0],"stderrBytes":sizes[1],"lastOutputAt":times.into_iter().reduce(f64::max),"interactive":interactive,"stopPending":false,"report":report}),
    )
}
