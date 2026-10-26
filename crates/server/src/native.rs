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
pub const NATIVE_OPS: &[&str] = &[
    "host.suggest",
    "notifications.get",
    "notifications.set",
    "repo.add",
    "repo.remove",
    "routing.get",
    "strategy.list",
    "strategy.show",
    "strategy.use",
];

pub struct Dispatcher {
    registry: Registry,
}
impl Dispatcher {
    pub fn new(forward: &str) -> Self {
        let mut ops: Vec<NativeOp> = pacer_config::ops().to_vec();
        ops.extend_from_slice(pacer_config::repo_ops());
        ops.extend_from_slice(pacer_config::repo_add_ops());
        ops.extend_from_slice(pacer_config::routing_ops());
        ops.extend_from_slice(pacer_config::strategy_list_ops());
        ops.extend_from_slice(pacer_config::strategy_use_ops());
        ops.extend_from_slice(pacer_config::host_suggest_ops());
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
        (matches!(name, "repo.add" | "repo.remove") && pacer_config::requires_core_repo_parser(ctx))
            || (name == "routing.get" && pacer_config::requires_core_routing_parser(ctx))
            || (name == "strategy.list" && pacer_config::requires_core_strategy_list_parser(ctx))
            || (name == "host.suggest" && pacer_config::requires_core_host_suggest_parser(ctx))
            || (matches!(name, "notifications.get" | "notifications.set")
                && pacer_config::requires_core_parser(ctx))
            || (name == "notifications.set" && pacer_config::requires_core_set_parser(ctx))
    }
    /// Request-specific selection after a bounded body parse. The transport
    /// keeps the original request bytes when this returns true.
    pub fn needs_core_request(&self, ctx: &Ctx, name: &str, params: &Value) -> bool {
        #[cfg(feature = "test-ops")]
        if name == "test.echo" && params["force_core"] == true {
            return true;
        }
        (name == "strategy.show" && pacer_config::requires_core_strategy_show_parser(ctx, params))
            || (name == "strategy.use"
                && pacer_config::requires_core_strategy_use_parser(ctx, params))
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
    use std::{collections::HashMap, fs, process::Command};
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
            &[
                "host.suggest",
                "notifications.get",
                "notifications.set",
                "repo.add",
                "repo.remove",
                "routing.get",
                "strategy.list",
                "strategy.show",
                "strategy.use"
            ]
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
    #[tokio::test]
    async fn strategy_list_selects_only_when_every_file_is_supported() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().join("home"),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
        let yaml =
            "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
        fs::write(ctx.pacer_home.join("strategy.yaml"), yaml).unwrap();
        let dispatcher = Dispatcher::new("");
        assert!(!dispatcher.needs_core_parser(&ctx, "strategy.list"));
        let result = dispatcher
            .call(&ctx, "strategy.list", json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result[0]["name"], "default");
        fs::write(
            ctx.pacer_home.join("strategies/broken.yaml"),
            "planner: [bad]\n",
        )
        .unwrap();
        assert!(dispatcher.needs_core_parser(&ctx, "strategy.list"));
        assert!(
            !Dispatcher::new("strategy.list")
                .names()
                .contains(&"strategy.list")
        );
    }
    #[tokio::test]
    async fn strategy_use_request_selector_and_forced_forwarding() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().join("pacer"),
            HashMap::new(),
            1_700_000_000.0,
        );
        fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
        let yaml =
            "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
        fs::write(ctx.pacer_home.join("strategy.yaml"), yaml).unwrap();
        fs::write(ctx.pacer_home.join("strategies/research.yaml"), yaml).unwrap();
        let dispatcher = Dispatcher::new("");
        let params = json!({"name":"research"});
        assert!(!dispatcher.needs_core_request(&ctx, "strategy.use", &params));
        assert!(dispatcher.needs_core_request(&ctx, "strategy.use", &json!({"name":"missing"})));
        assert!(
            Dispatcher::new("strategy.use")
                .call(&ctx, "strategy.use", params.clone())
                .await
                .is_none()
        );
        let result = dispatcher
            .call(&ctx, "strategy.use", params)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["name"], "research");
        assert_eq!(
            fs::read(ctx.pacer_home.join("active")).unwrap(),
            b"research\n"
        );
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
    #[test]
    fn repo_add_selects_core_for_unsupported_registry_json() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        let dispatcher = Dispatcher::new("");
        assert!(!dispatcher.needs_core_parser(&ctx, "repo.add"));
        fs::create_dir_all(ctx.pacer_home.join("state")).unwrap();
        fs::write(
            ctx.pacer_home.join("state/repos.json"),
            r#"{"/repo":{"key":"\ud800"}}"#,
        )
        .unwrap();
        assert!(dispatcher.needs_core_parser(&ctx, "repo.add"));
        assert!(!Dispatcher::new("repo.add").names().contains(&"repo.add"));
    }
    #[tokio::test]
    async fn fractional_timestamp_keeps_two_public_repo_add_calls_native() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        fs::create_dir(&path).unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(["init", "-q", "-b", "main"])
                .status()
                .unwrap()
                .success()
        );
        let ctx = Ctx::with(
            dir.path().join("home"),
            dir.path().join("pacer"),
            HashMap::new(),
            1_793_042_681.555,
        );
        let dispatcher = Dispatcher::new("");
        let params = json!({"path":path});
        for _ in 0..2 {
            assert!(!dispatcher.needs_core_parser(&ctx, "repo.add"));
            let result = dispatcher.call(&ctx, "repo.add", params.clone()).await;
            assert!(matches!(result, Some(Ok(_))), "{result:?}");
        }
        assert!(!dispatcher.needs_core_parser(&ctx, "repo.add"));
    }
    #[tokio::test]
    async fn routing_get_selects_native_only_for_supported_strategy_shape() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().join("home"),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        fs::create_dir_all(&ctx.pacer_home).unwrap();
        let path = ctx.pacer_home.join("strategy.yaml");
        fs::write(&path, "accounts: {personal: {kind: claude}, codex: {kind: codex}}\nplanner: claude-code\nrouting: [{default: [codex]}]\n").unwrap();
        let dispatcher = Dispatcher::new("");
        assert!(!dispatcher.needs_core_parser(&ctx, "routing.get"));
        assert_eq!(
            dispatcher.call(&ctx, "routing.get", json!({})).await,
            Some(Ok(
                json!({"rules":[{"executors":["codex"]}],"available":["claude-code","codex"]})
            ))
        );
        assert!(
            Dispatcher::new("routing.get")
                .call(&ctx, "routing.get", json!({}))
                .await
                .is_none()
        );
        fs::write(&path, "accounts: {personal: {kind: claude}}\nplanner: claude-code\nhosts: {box: {ssh: box, max_tasks: 3}}\n").unwrap();
        assert!(dispatcher.needs_core_parser(&ctx, "routing.get"));
    }
    #[tokio::test]
    async fn host_suggest_selects_native_only_for_supported_local_config() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().join("home"),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        fs::create_dir_all(ctx.pacer_home.clone()).unwrap();
        fs::create_dir_all(ctx.home.join(".ssh")).unwrap();
        fs::write(ctx.pacer_home.join("strategy.yaml"),
            "accounts: {personal: {kind: claude}}\nplanner: claude-code\nhosts: {devbox: {ssh: dev-ssh}}\n").unwrap();
        let config = ctx.home.join(".ssh/config");
        fs::write(&config, "Host dev-ssh fresh-box\n").unwrap();
        let dispatcher = Dispatcher::new("");
        assert!(!dispatcher.needs_core_parser(&ctx, "host.suggest"));
        assert_eq!(
            dispatcher.call(&ctx, "host.suggest", json!({})).await,
            Some(Ok(json!(["fresh-box"])))
        );
        assert!(
            Dispatcher::new("host.suggest")
                .call(&ctx, "host.suggest", json!({}))
                .await
                .is_none()
        );
        fs::write(config, "Include conf.d/*\n").unwrap();
        assert!(dispatcher.needs_core_parser(&ctx, "host.suggest"));
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
