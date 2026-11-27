//! Native `setup.skip` (`src/core/setup.ts:173-186`, `src/api/ops.ts:404`).
//!
//! The `config` lock serialises concurrent skips, `settings.json` keeps its other keys,
//! and the `config` mutation publishes the change like the TypeScript op wrapper.
#![allow(clippy::result_large_err)]
use pacer_config_ops::executor_setup_ops::{invalid, type_name};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::{read_json, write_json_atomic},
    lock::{LockOptions, with_lock},
};
use pacer_store::publish_config_change;
use serde_json::{Map, Value, json};

fn validate(params: &Value) -> Result<(), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(Some(params))
        ))
    })?;
    // `z.object` strips unknown keys, so only `step` is checked.
    if map.get("step").and_then(Value::as_str) != Some("notifications") {
        return Err(invalid("step: Invalid input: expected \"notifications\""));
    }
    Ok(())
}

pub fn setup_skip(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        validate(&params)?;
        with_lock(ctx, "config", LockOptions::default(), || {
            let file = ctx.pacer_home.join("settings.json");
            let mut settings: Map<String, Value> = read_json(&file).unwrap_or_default();
            let mut setup = settings
                .get("setup")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            setup.insert("notifications_skipped".into(), Value::Bool(true));
            settings.insert("setup".into(), Value::Object(setup));
            write_json_atomic(&file, &Value::Object(settings))
                .map_err(|e| invalid(e.to_string()))
        })
        .map_err(|e| CoreError::new(Code::Internal, format!("config lock: {e}")))??;
        publish_config_change(ctx, "config").map_err(|e| {
            CoreError::new(Code::Internal, format!("setup publication failed: {e}"))
        })?;
        Ok(json!({"skipped": true}))
    })
}

/// Native operation table provided alongside `onboarding.skip`.
pub const fn ops() -> &'static [pacer_foundation::api::NativeOp] {
    &[pacer_foundation::api::NativeOp {
        name: "setup.skip",
        call: setup_skip,
    }]
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    fn ctx() -> (tempfile::TempDir, Ctx) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        (
            dir,
            Ctx::with(home.clone(), home.clone(), HashMap::new(), 10.0),
        )
    }

    fn run(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(setup_skip(ctx, params))
    }

    #[test]
    fn skip_keeps_other_settings_and_publishes_a_config_event() {
        let (_dir, ctx) = ctx();
        fs_write(&ctx, r#"{"notifications":"off","setup":{"planner_done":true}}"#);
        assert_eq!(
            run(&ctx, json!({"step": "notifications"})).unwrap(),
            json!({"skipped": true})
        );
        let text = std::fs::read_to_string(ctx.pacer_home.join("settings.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["notifications"], json!("off"));
        assert_eq!(value["setup"]["planner_done"], json!(true));
        assert_eq!(value["setup"]["notifications_skipped"], json!(true));
        let outbox = std::fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl")).unwrap();
        let events: Vec<Value> = outbox
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let config = events
            .iter()
            .find(|event| event["envelope"]["type"] == "config")
            .expect("config event");
        assert_eq!(config["envelope"]["data"]["area"], json!("config"));
    }

    #[test]
    fn skip_from_an_empty_home_creates_the_setup_object() {
        let (_dir, ctx) = ctx();
        run(&ctx, json!({"step": "notifications"})).unwrap();
        let value: Value = serde_json::from_slice(
            &std::fs::read(ctx.pacer_home.join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value, json!({"setup": {"notifications_skipped": true}}));
    }

    #[test]
    fn an_unknown_step_is_a_zod_literal_issue() {
        let (_dir, ctx) = ctx();
        let error = run(&ctx, json!({"step": "x"})).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(error.message, "step: Invalid input: expected \"notifications\"");
    }

    fn fs_write(ctx: &Ctx, text: &str) {
        let path = ctx.pacer_home.join("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}
