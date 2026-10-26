//! Startup-selected native operations. Unknown names retain core ownership.
pub use pacer_foundation::api::error::CoreError as ApiError;
use pacer_foundation::{
    Ctx,
    api::{
        error::CoreError,
        registry::{NativeOp, Registry},
    },
};
use serde_json::Value;

/// Production operations currently selected by the native registry.
pub const NATIVE_OPS: &[&str] = &["notifications.get", "notifications.set", "repo.remove"];

pub struct Dispatcher {
    registry: Registry,
}
impl Dispatcher {
    pub fn new(forward: &str) -> Self {
        let mut ops: Vec<NativeOp> = pacer_config::ops().to_vec();
        ops.extend_from_slice(pacer_config::repo_ops());
        #[cfg(feature = "test-ops")]
        ops.push(NativeOp {
            name: "test.echo",
            call: |_, params| Box::pin(async move { Ok(params) }),
        });
        // Registry deliberately uses last-wins; assembled domain lists must instead
        // reject collisions when domain registrations are introduced.
        ops.sort_by_key(|op| op.name);
        Self {
            registry: Registry::new(&ops, forward),
        }
    }
    /// Read once per transport startup; never consult environment per request.
    pub fn startup() -> Self {
        let forward = std::env::var("PACER_FORWARD_OPS").unwrap_or_default();
        if !forward.trim().is_empty() {
            eprintln!("pacer: PACER_FORWARD_OPS={forward}");
        }
        Self::new(&forward)
    }
    pub fn names(&self) -> Vec<&'static str> {
        self.registry.names()
    }
    /// Some legacy JSON is accepted by JavaScript but not serde_json. Forward
    /// that request before consuming it so its parsing and file behavior stay exact.
    pub fn needs_core_parser(&self, ctx: &Ctx, name: &str) -> bool {
        (name == "repo.remove" && pacer_config::requires_core_repo_parser(ctx))
            || (matches!(name, "notifications.get" | "notifications.set")
                && pacer_config::requires_core_parser(ctx))
            || (name == "notifications.set" && pacer_config::requires_core_set_parser(ctx))
    }
    /// Merge selected native names with the actual core hello advertisement.
    pub fn decorate_hello(&self, hello: &mut Value) {
        if self.names().is_empty() {
            return;
        }
        if let Some(ops) = hello.get_mut("ops").and_then(Value::as_array_mut) {
            let names: std::collections::BTreeSet<String> = ops
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .chain(self.names().into_iter().map(str::to_owned))
                .collect();
            *ops = names.into_iter().map(Value::String).collect();
        }
    }
    /// Core unknown-op hints use the same current opNames source as hello.
    pub fn decorate_hint(&self, hint: &mut Value) {
        if self.names().is_empty() {
            return;
        }
        if let Some(names) = hint
            .as_str()
            .and_then(|hint| hint.strip_prefix("operations: "))
        {
            let names: std::collections::BTreeSet<&str> =
                names.split(", ").chain(self.names()).collect();
            *hint = Value::String(format!(
                "operations: {}",
                names.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }
    pub async fn call(
        &self,
        ctx: &Ctx,
        name: &str,
        params: Value,
    ) -> Option<Result<Value, CoreError>> {
        let op = self.registry.get(name)?;
        Some((op.call)(ctx, params).await)
    }
}
#[cfg(test)]
pub(crate) fn error_dispatcher() -> Dispatcher {
    use pacer_foundation::api::error::Code;
    Dispatcher {
        registry: Registry::new(
            &[NativeOp {
                name: "test.error",
                call: |_, params| {
                    Box::pin(async move {
                        let code: Code = serde_json::from_value(params)
                            .map_err(|_| CoreError::new(Code::InvalidInput, "invalid code"))?;
                        let mut error = CoreError::new(code, "message").hint("retry");
                        error.data = Some(Box::new(serde_json::Map::from_iter([(
                            "detail".into(),
                            Value::Bool(true),
                        )])));
                        Err(error)
                    })
                },
            }],
            "",
        ),
    }
}

#[cfg(test)]
pub(crate) fn slow_dispatcher() -> Dispatcher {
    Dispatcher {
        registry: Registry::new(
            &[NativeOp {
                name: "test.slow",
                call: |_, params| {
                    Box::pin(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        if params == Value::Bool(false) {
                            Err(CoreError::new(
                                pacer_foundation::api::error::Code::Conflict,
                                "slow error",
                            ))
                        } else {
                            Ok(params)
                        }
                    })
                },
            }],
            "",
        ),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod registry_tests {
    use super::*;
    use serde_json::json;
    use std::{collections::HashMap, fs};
    #[tokio::test]
    async fn dispatcher_respects_startup_forwarding() {
        let dispatcher = Dispatcher::new("test.echo");
        assert!(
            dispatcher
                .call(&Ctx::from_env(), "test.echo", json!({}))
                .await
                .is_none()
        );
        assert!(Dispatcher::new("*").names().is_empty());
        assert_eq!(
            NATIVE_OPS,
            &["notifications.get", "notifications.set", "repo.remove"]
        );
        #[cfg(not(feature = "test-ops"))]
        assert_eq!(Dispatcher::new("").names(), NATIVE_OPS);
    }
    #[test]
    fn notification_operations_are_native_unless_explicitly_forwarded() {
        for name in NATIVE_OPS {
            assert!(Dispatcher::new("").names().contains(name));
            assert!(!Dispatcher::new(name).names().contains(name));
        }
    }
    #[test]
    fn notification_write_keeps_javascript_number_and_key_cases_with_core() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().join("home"),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        fs::create_dir_all(&ctx.pacer_home).unwrap();
        let path = ctx.pacer_home.join("settings.json");
        let dispatcher = Dispatcher::new("");
        for body in [
            r#"{"2":"two","1":"one"}"#,
            r#"{"minus":-0,"float":1e21}"#,
            r#"{"big":9007199254740993}"#,
            r#"{"nested":{"3":true,"2":false}}"#,
        ] {
            fs::write(&path, body).unwrap();
            assert!(
                dispatcher.needs_core_parser(&ctx, "notifications.set"),
                "{body}"
            );
        }
        fs::write(path, r#"{"other":42,"enabled":true}"#).unwrap();
        assert!(!dispatcher.needs_core_parser(&ctx, "notifications.set"));
    }
    #[tokio::test]
    async fn repo_remove_is_native_but_can_be_forced_to_core() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        assert!(
            Dispatcher::new("repo.remove")
                .call(&ctx, "repo.remove", json!({"key":"missing"}))
                .await
                .is_none()
        );
        assert_eq!(
            Dispatcher::new("")
                .call(&ctx, "repo.remove", json!({"key":"missing"}))
                .await,
            Some(Ok(json!({"removed":true})))
        );
        assert_eq!(
            fs::read_to_string(ctx.pacer_home.join("state/repos.json")).unwrap(),
            "{}"
        );
    }
    #[cfg(feature = "test-ops")]
    #[tokio::test]
    async fn explicit_test_feature_dispatches_echo() {
        assert_eq!(
            Dispatcher::new("")
                .call(&Ctx::from_env(), "test.echo", json!({"ok":true}))
                .await,
            Some(Ok(json!({"ok":true})))
        );
    }
}
