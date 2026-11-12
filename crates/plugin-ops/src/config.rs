#[allow(clippy::result_large_err)]
pub fn read_config(
    ctx: &pacer_foundation::Ctx,
) -> Result<serde_json::Value, pacer_foundation::api::CoreError> {
    match pacer_config::strategy::load_strategy(&ctx.pacer_home) {
        Ok(s) => Ok(pacer_js_json::quoted::from_utf8(s["plugins"].clone())),
        Err(pacer_config::strategy::StrategyError::Missing(_)) => Ok(
            serde_json::json!({"policy":{"mode":"open"},"disabled":[],"installed":{},"config":{}}),
        ),
        Err(e) => Err(crate::private::internal(e)),
    }
}
#[allow(clippy::result_large_err)]
pub fn edit_config(
    ctx: &pacer_foundation::Ctx,
    id: &str,
    disabled: Option<bool>,
    grant: Option<Option<serde_json::Value>>,
) -> Result<(), pacer_foundation::api::CoreError> {
    use serde_json::json;
    let invalid = |e: String| {
        pacer_foundation::api::CoreError::new(pacer_foundation::api::Code::InvalidInput, e)
    };
    let configured_home = ctx.pacer_home.clone();
    crate::private::locked(ctx, "plugins", |ctx| {
        let display_ctx = pacer_foundation::Ctx {
            pacer_home: configured_home.clone(),
            ..ctx.clone()
        };
        let cfg = read_config(&display_ctx)?;
        let (display_path, _) = pacer_config::strategy::strategy_path(&configured_home)
            .map_err(|e| invalid(e.to_string()))?;
        let (path, _) = pacer_config::strategy::strategy_path(&ctx.pacer_home)
            .map_err(|e| invalid(e.to_string()))?;
        let before = std::fs::read_to_string(&path)
            .map_err(|e| invalid(crate::private::io_error(e, "open", &display_path).message))?;
        let mut doc = pacer_config::doc::StrategyDoc::new(&before);
        if let Some(disabled) = disabled {
            let mut next = cfg["disabled"].as_array().cloned().unwrap_or_default();
            if disabled {
                let mut seen = std::collections::HashSet::new();
                next.retain(|v| seen.insert(v.to_string()));
                if !next.contains(&json!(id)) {
                    next.push(json!(id));
                }
            } else {
                next.retain(|v| v != id);
            }
            if cfg["disabled"] != json!(next) {
                doc.set_in(&[json!("plugins"), json!("disabled")], &json!(next))
                    .map_err(|e| invalid(e.to_string()))?;
            }
        }
        if let Some(grant) = grant {
            let key = [json!("plugins"), json!("installed"), json!(id)];
            if let Some(grant) = grant {
                doc.set_in(&key, &grant)
                    .map_err(|e| invalid(e.to_string()))?;
            } else if cfg["installed"].get(id).is_some() {
                doc.delete_in(&key).map_err(|e| invalid(e.to_string()))?;
            }
        }
        if before != doc.as_str() {
            let raw =
                pacer_config::doc::parse_value(doc.as_str()).map_err(|e| invalid(e.to_string()))?;
            pacer_config::strategy::validate_strategy(&raw, &display_path, "default")
                .map_err(|e| invalid(e.to_string()))?;
            if std::fs::read_to_string(&path)
                .map_err(|e| invalid(crate::private::io_error(e, "open", &display_path).message))?
                != before
            {
                return Err(pacer_foundation::api::CoreError::new(
                    pacer_foundation::api::Code::Conflict,
                    "strategy changed during edit; retry",
                ));
            }
            crate::private::write_shared(&path, doc.as_str().as_bytes())
                .map_err(|e| invalid(e.message))?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests;
