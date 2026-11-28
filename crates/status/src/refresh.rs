//! Usage refresh (`src/usage/refresh.ts`). The pure capability/outcome rules
//! moved here (from `pacer_engine::usage_refresh`, unchanged) and live in
//! `pacer-config` so the lower-layer account and limits ops can share them.
//! `refresh_all_usage` fans out over the configured accounts through [`UsageReads`].

use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::Value;

use crate::usage::UsageReads;

pub mod rules {
    //! The pure rules from `crates/engine/src/usage_refresh.rs`, moved unchanged.
    pub use pacer_config::usage_refresh::*;

    #[cfg(test)]
    mod tests {
        #![allow(clippy::unwrap_used)]
        use super::*;
        use serde_json::json;

        #[test]
        fn capability_matches_adapter_matrix() {
            assert_eq!(
                refresh_capability(&json!({"kind":"claude","usage":"quota"})),
                "passive-log"
            );
            assert_eq!(
                refresh_capability(&json!({"kind":"codex","usage":"quota"})),
                "provider-command"
            );
            assert_eq!(
                refresh_capability(
                    &json!({"kind":"endpoint","name":"plan","usage":"quota","quotaSource":"arkcli"})
                ),
                "provider-command"
            );
            assert_eq!(
                refresh_capability(&json!({"kind":"cursor","usage":"reactive"})),
                "unavailable"
            );
        }

        #[test]
        fn outcome_updated_when_captured_at_advances() {
            let prior = json!({"capturedAt": 100.0, "stale": false});
            let current = json!({"capturedAt": 200.0, "stale": false});
            assert_eq!(
                refresh_outcome("provider-command", &prior, &current),
                "updated"
            );
        }

        #[test]
        fn passive_log_error_stays_unchanged() {
            let prior = json!({"capturedAt": null, "stale": false});
            let current = json!({"capturedAt": null, "stale": false, "error": "boom"});
            assert_eq!(
                refresh_outcome("passive-log", &prior, &current),
                "unchanged"
            );
        }
    }
}

pub use self::rules::{
    AUTOMATIC_INTERVAL_S, automatic_refresh_suppressed, provider_id, refresh_capability,
    refresh_outcome,
};

/// `refreshAllUsage` (`src/usage/refresh.ts:48-51`): one result per configured
/// account, in strategy order.
pub async fn refresh_all_usage(
    usage: &dyn UsageReads,
    ctx: &Ctx,
    automatic: bool,
) -> Result<Value, CoreError> {
    let strategy = load_strategy(&ctx.pacer_home)
        .map_err(|e| CoreError::new(Code::Internal, format!("load strategy: {e}")))?;
    let names: Vec<String> = strategy["accounts"]
        .as_object()
        .map(|accounts| accounts.keys().cloned().collect())
        .unwrap_or_default();
    let mut results = Vec::with_capacity(names.len());
    for name in names {
        results.push(usage.refresh_account_usage(ctx, &name, automatic).await?);
    }
    Ok(Value::Array(results))
}
