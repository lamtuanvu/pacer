//! Manual exhausted marks (`exhausted.json` + `state/exhausted-evidence.json`).
//! Matches `src/usage/reactive.ts` `markExhausted` for the `limits.report` path.
use pacer_foundation::{
    Ctx,
    fsutil::{read_json, write_json_atomic},
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use std::{fs, io, time::Duration};

fn marks_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("exhausted.json")
}

fn evidence_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("state/exhausted-evidence.json")
}

/// Read current marks file (empty when missing).
pub fn read_marks(ctx: &Ctx) -> Map<String, Value> {
    read_json::<Map<String, Value>>(&marks_path(ctx)).unwrap_or_default()
}

/// Record that `id` is exhausted until `until` (unix seconds). `manual` is always
/// true for `limits.report`.
pub fn mark_exhausted(ctx: &Ctx, id: &str, until: f64, manual: bool) -> Result<(), String> {
    if !until.is_finite() {
        return Err("until must be unix seconds".into());
    }
    let options = LockOptions {
        timeout: Duration::from_secs(20),
        ..LockOptions::default()
    };
    with_lock(ctx, "exhausted-evidence", options, || -> io::Result<()> {
        let mut marks = read_marks(ctx);
        marks.insert(id.to_owned(), json!(until));
        write_json_atomic(&marks_path(ctx), &Value::Object(marks))?;
        let mut evidence = read_json::<Map<String, Value>>(&evidence_path(ctx)).unwrap_or_default();
        evidence.insert(
            id.to_owned(),
            json!({"observedAt": ctx.now, "until": until, "manual": manual}),
        );
        let parent = ctx.pacer_home.join("state");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&parent)?;
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(&parent)?;
        write_json_atomic(&evidence_path(ctx), &Value::Object(evidence))?;
        Ok(())
    })
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[test]
    fn mark_writes_both_files() {
        let dir = tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().to_path_buf(),
            dir.path().join(".pacer"),
            HashMap::new(),
            50.0,
        );
        mark_exhausted(&ctx, "codex", 110.0, true).unwrap();
        assert_eq!(read_marks(&ctx)["codex"], 110.0);
        let evidence = read_json::<Value>(&evidence_path(&ctx)).unwrap();
        assert_eq!(evidence["codex"]["manual"], true);
        assert_eq!(evidence["codex"]["until"], 110.0);
    }
}
