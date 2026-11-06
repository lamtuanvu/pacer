//! Setup mutations that are pure on disk (`onboarding.skip`).
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::publish_config_change;
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};

use super::lifecycle_ops::{invalid, type_name};

fn empty_object(params: &Value) -> Result<(), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    Ok(())
}

fn write_skipped_marker(dir: &Path) -> Result<(), CoreError> {
    fs::create_dir_all(dir).map_err(|e| invalid(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if let Ok(meta) = fs::metadata(dir) {
            let mut perms = meta.permissions();
            perms.set_mode(0o700);
            let _ = fs::set_permissions(dir, perms);
        }
        let tmp = dir.join(format!(".skipped-{}", uuid_simple()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| invalid(e.to_string()))?;
        file.write_all(&[]).map_err(|e| invalid(e.to_string()))?;
        drop(file);
        fs::rename(&tmp, dir.join("skipped")).map_err(|e| invalid(e.to_string()))?;
    }
    #[cfg(not(unix))]
    {
        let path = dir.join("skipped");
        fs::write(&path, &[]).map_err(|e| invalid(e.to_string()))?;
    }
    Ok(())
}

fn uuid_simple() -> String {
    let bytes: [u8; 16] = rand::random();
    hex::encode(bytes)
}

pub(super) fn onboarding_skip(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        empty_object(&params)?;
        let dir = ctx.pacer_home.join("onboarding");
        write_skipped_marker(&dir)?;
        publish_config_change(ctx, "setup").map_err(|e| {
            CoreError::new(Code::Internal, format!("setup publication failed: {e}"))
        })?;
        Ok(json!({"skipped": true}))
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;

    #[test]
    fn onboarding_skip_writes_marker() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home.clone(), HashMap::new(), 1.0);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(onboarding_skip(&ctx, json!({})))
            .unwrap();
        assert!(home.join("onboarding/skipped").is_file());
    }
}
