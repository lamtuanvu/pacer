#![allow(clippy::result_large_err)]
//! The door's implementation of [`AssistantHost`]: the plugin registry snapshot over
//! Core's private plugin channel and the read-only usage parts behind the status bridge.
//! No usage source is refreshed here; the `cacheOnly` parts are exactly what TypeScript's
//! `cachedStatus` reads for admission and candidates.

use pacer_assistant_ops::assistant_ops::AssistantHost;
use pacer_core_bridge::status_sync;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_plugin_ops::extension::{EntriesFuture, ExtensionCalls};
use serde_json::{Value, json};

use super::{extension_calls::DoorCalls, plugins::CoreLink};

fn unavailable(message: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Unavailable, message.to_string())
}

/// The HTTP door's view of Core for one assistant status/candidates call.
pub(crate) struct HttpHost {
    plugins: DoorCalls,
    target: Option<(u16, String)>,
}

impl HttpHost {
    pub(crate) fn new(link: CoreLink, target: Option<(u16, String)>) -> Self {
        Self {
            plugins: DoorCalls::new(link),
            target,
        }
    }
}

impl AssistantHost for HttpHost {
    fn plugins<'a>(&'a mut self, ctx: &'a Ctx) -> EntriesFuture<'a> {
        self.plugins.entries(ctx)
    }

    fn cached_status_parts(&mut self) -> OpFuture<'_> {
        let target = self.target.clone();
        Box::pin(async move {
            let target = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
            status_sync::http(Some(target), json!({"cacheOnly": true})).await
        })
    }
}

/// The stdio door's view of Core, mirroring `assistant_turn_sync::StdioBridge`.
pub(crate) struct StdioHost<'a, W> {
    plugins: DoorCalls,
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<'a, W> StdioHost<'a, W> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        link: CoreLink,
        core: &'a mut W,
        prefix: &'a str,
        key: &'a str,
        replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) -> Self {
        Self {
            plugins: DoorCalls::new(link),
            core,
            prefix,
            key,
            replies,
        }
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> AssistantHost for StdioHost<'_, W> {
    fn plugins<'a>(&'a mut self, ctx: &'a Ctx) -> EntriesFuture<'a> {
        self.plugins.entries(ctx)
    }

    fn cached_status_parts(&mut self) -> OpFuture<'_> {
        Box::pin(status_sync::stdio(
            &mut *self.core,
            self.prefix,
            self.key,
            json!({"cacheOnly": true}),
            &mut *self.replies,
        ))
    }
}
