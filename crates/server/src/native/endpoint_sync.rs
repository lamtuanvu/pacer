//! Server adapters implementing `EndpointPlugin` over B0b's plugin owner.
//! Both front doors hand the native sync future to `call_native`; the trait
//! keeps `pacer-config-ops` independent of the plugin runtime.
use super::plugins::{self, CoreLink};
use crate::stdio_plugins::PluginLink;
use pacer_config_ops::endpoint_sync::EndpointPlugin;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;
use std::sync::Arc;

/// Adapt the `()` result into the `Value` result the shared edit future expects.
pub fn future<'a>(ctx: &'a Ctx, plugin: &'a dyn EndpointPlugin) -> OpFuture<'a> {
    Box::pin(async move {
        pacer_config_ops::endpoint_sync::sync_endpoint_config(ctx, plugin)
            .await
            .map(|()| Value::Null)
    })
}

/// HTTP door: Core's generation-token plugin channel.
pub(crate) struct ServeEndpoint<'a> {
    pub(crate) service: &'a plugins::Service,
    pub(crate) core: &'a crate::serve::core_child::CoreChild,
}

impl EndpointPlugin for ServeEndpoint<'_> {
    fn launch_env<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let core = plugins::http_link(self.core);
        Box::pin(
            self.service
                .call_endpoint_method(ctx, core, "endpoint.launchEnv", params),
        )
    }
}

/// Stdio door: the sync-keyed `_internal.plugins` line to this connection's Core.
pub(crate) struct StdioEndpoint<'a> {
    pub(crate) service: &'a plugins::Service,
    pub(crate) link: &'a Arc<PluginLink>,
}

impl EndpointPlugin for StdioEndpoint<'_> {
    fn launch_env<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let ipc: Arc<dyn pacer_plugin_ops::ipc::CoreIpc> = self.link.clone();
        let core = async move { Some((ipc, String::new())) as Option<CoreLink> };
        Box::pin(
            self.service
                .call_endpoint_method(ctx, core, "endpoint.launchEnv", params),
        )
    }
}

/// Fixture adapter used by the parity driver: no Core child exists there, so
/// answer from the caller's own strategy. An unavailable endpoint plugin keeps
/// the existing parity fixtures silent; a configured endpoint returns the
/// exact owned launch settings the bundled plugin would.
pub struct FixtureEndpoint;

impl EndpointPlugin for FixtureEndpoint {
    fn launch_env<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        Box::pin(async move {
            let pacer_home = params["pacerHome"].as_str().unwrap_or("");
            let disabled = pacer_config::strategy::load_strategy(&ctx.pacer_home)
                .map(|strategy| {
                    strategy["plugins"]["disabled"]
                        .as_array()
                        .is_some_and(|list| list.iter().any(|id| id.as_str() == Some("pacer-endpoints")))
                })
                .unwrap_or(true);
            if disabled {
                return Err(CoreError::new(
                    Code::PluginUnavailable,
                    "no enabled plugin provides OpenAI-compatible endpoints",
                ));
            }
            let mut secret_env = serde_json::Map::new();
            if let Some(account) = params["account"].as_object() {
                if let Some(reference) = account["keyRef"].as_str() {
                    let name = account["name"].as_str().unwrap_or("");
                    secret_env.insert(
                        format!("PACER_KEY_{}", name.to_uppercase().replace('-', "_")),
                        serde_json::Value::String(reference.to_owned()),
                    );
                }
            }
            Ok(serde_json::json!({
                "env": {"OPENCODE_CONFIG": format!("{pacer_home}/opencode/opencode.json")},
                "secretEnv": secret_env
            }))
        })
    }
}
