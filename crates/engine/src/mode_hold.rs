//! Mode hold file (`state/mode-hold.json`), matching `src/core/mode-hold.ts`.
use pacer_foundation::{
    Ctx,
    fsutil::{read_json, write_json_atomic},
};
use serde_json::{Value, json};
use std::fs;

const MODES: &[&str] = &["strict", "normal", "relaxed", "emergency"];

/// 2^64: a `Value` holds no larger integer, so serde_json writes a larger `until` in exponent
/// form where `JSON.stringify` writes digits and zeros below 1e21. Callers forward from here on.
pub const UNTIL_WRITTEN_IN_FULL: f64 = 18_446_744_073_709_551_616.0;

fn path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("state/mode-hold.json")
}

fn valid_mode(mode: &str) -> bool {
    MODES.contains(&mode)
}

/// Hold `mode` until a future unix timestamp. Callers default a missing `until`
/// with [`crate::status::default_mode_hold_until`].
pub fn hold(ctx: &Ctx, mode: &str, until: f64) -> Result<Value, String> {
    if !valid_mode(mode) {
        return Err("unknown mode".into());
    }
    if !until.is_finite() || until <= ctx.now {
        return Err("mode hold until must be a future unix timestamp".into());
    }
    // `JSON.stringify` writes an integral number below 1e21 as its shortest round-trip digits
    // padded with zeros, as `f64`'s `Display` does, without a fraction.
    let until = format!("{until}")
        .parse::<u64>()
        .map_or_else(|_| json!(until), |integral| json!(integral));
    let state = json!({"mode": mode, "until": until});
    write_json_atomic(&path(ctx), &state).map_err(|e| e.to_string())?;
    Ok(state)
}

/// Remove the hold file.
pub fn release(ctx: &Ctx) -> Result<Value, String> {
    let _ = fs::remove_file(path(ctx));
    Ok(json!({"released": true}))
}

/// Active hold, or `None` when missing/expired/malformed.
pub fn read_hold(ctx: &Ctx) -> Option<Value> {
    let state = read_json::<Value>(&path(ctx))?;
    let mode = state.get("mode")?.as_str()?;
    let until = state.get("until")?.as_f64()?;
    if valid_mode(mode) && until.is_finite() && until > ctx.now {
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
    fn hold_requires_future_until() {
        let (_dir, ctx) = ctx(100.0);
        assert!(hold(&ctx, "invalid", 200.0).is_err());
        assert!(hold(&ctx, "normal", 100.0).is_err());
        let state = hold(&ctx, "emergency", 160.0).unwrap();
        let written = r#"{"mode":"emergency","until":160}"#;
        assert_eq!(state.to_string(), written);
        let file = fs::read_to_string(path(&ctx)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&file).unwrap().to_string(),
            written
        );
        assert_eq!(read_hold(&ctx).unwrap()["mode"], "emergency");
        assert_eq!(hold(&ctx, "normal", 160.5).unwrap()["until"], json!(160.5));
        for (until, written) in [
            (1e16, r#"{"mode":"relaxed","until":10000000000000000}"#),
            (
                9_007_199_254_740_994.0,
                r#"{"mode":"relaxed","until":9007199254740994}"#,
            ),
            (
                18_446_744_073_709_549_568.0,
                r#"{"mode":"relaxed","until":18446744073709550000}"#,
            ),
        ] {
            assert_eq!(hold(&ctx, "relaxed", until).unwrap().to_string(), written);
            assert_eq!(fs::read_to_string(path(&ctx)).unwrap(), written);
        }
        assert_eq!(release(&ctx).unwrap(), json!({"released": true}));
        assert!(read_hold(&ctx).is_none());
    }
}
