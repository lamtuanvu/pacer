//! Delegation pause file (`state/pause.json`), matching `src/core/pause.ts`.
use pacer_foundation::{
    Ctx,
    fsutil::{read_json, write_json_atomic},
};
use serde_json::{Value, json};
use std::fs;

const MAX_SECONDS: f64 = 7.0 * 86400.0;

fn path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("state/pause.json")
}

/// Parse a whole-minute/hour/day duration up to seven days (`/^(\d+)(m|h|d)$/`).
pub fn parse_duration(text: &str) -> Result<f64, &'static str> {
    let err = "pause duration must be whole minutes, hours or days, up to 7 days";
    let bytes = text.as_bytes();
    if bytes.len() < 2 {
        return Err(err);
    }
    let (num, unit) = (&text[..text.len() - 1], bytes[bytes.len() - 1]);
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return Err(err);
    }
    let Ok(count) = num.parse::<f64>() else {
        return Err(err);
    };
    let factor = match unit {
        b'm' => 60.0,
        b'h' => 3600.0,
        b'd' => 86400.0,
        _ => return Err(err),
    };
    let seconds = count * factor;
    if !seconds.is_finite() || seconds <= 0.0 || seconds > MAX_SECONDS {
        return Err(err);
    }
    Ok(seconds)
}

/// Write a pause lasting `for_duration` (e.g. `1h`).
pub fn pause(
    ctx: &Ctx,
    for_duration: &str,
    reason: Option<&str>,
    by: Option<&str>,
) -> Result<Value, String> {
    let seconds = parse_duration(for_duration).map_err(str::to_owned)?;
    let state = json!({
        "until": ctx.now + seconds,
        "reason": reason,
        "by": by,
    });
    write_json_atomic(&path(ctx), &state).map_err(|e| e.to_string())?;
    Ok(state)
}

/// Clear the pause file.
pub fn resume(ctx: &Ctx) -> Result<Value, String> {
    let _ = fs::remove_file(path(ctx));
    Ok(json!({"resumed": true}))
}

/// Active pause, or `None` when missing/expired/malformed.
pub fn read_pause(ctx: &Ctx) -> Option<Value> {
    let state = read_json::<Value>(&path(ctx))?;
    let until_ok = match state.get("until") {
        Some(Value::Null) => true,
        Some(v) => v.as_f64().is_some_and(|n| n.is_finite() && n > ctx.now),
        None => false,
    };
    let text_ok = |key| matches!(state.get(key), Some(Value::Null) | Some(Value::String(_)));
    if until_ok && text_ok("reason") && text_ok("by") {
        Some(state)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn ctx(now: f64) -> (tempfile::TempDir, Ctx) {
        let dir = tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().to_path_buf(),
            dir.path().join(".pacer"),
            HashMap::new(),
            now,
        );
        (dir, ctx)
    }

    #[test]
    fn duration_bounds_and_units() {
        assert_eq!(parse_duration("7d").unwrap(), 604800.0);
        assert_eq!(parse_duration("1h").unwrap(), 3600.0);
        assert_eq!(parse_duration("30m").unwrap(), 1800.0);
        for bad in ["8d", "0m", "-1h", "1.5h", "1s", "", "h", "1"] {
            assert!(parse_duration(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn pause_resume_round_trip() {
        let (_dir, ctx) = ctx(1_000.0);
        let state = pause(&ctx, "1h", Some("break"), Some("planner")).unwrap();
        assert_eq!(state["until"], 4600.0);
        assert_eq!(read_pause(&ctx).unwrap()["reason"], "break");
        assert_eq!(resume(&ctx).unwrap(), json!({"resumed": true}));
        assert!(read_pause(&ctx).is_none());
    }
}
