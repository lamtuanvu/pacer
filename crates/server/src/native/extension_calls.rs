//! The serve door's view of the plugin registry as a native op needs it, before
//! B0c moves the registry into Rust. [`DoorCalls`] talks to Core's private
//! `/_internal/plugins` channel with the two kinds host-originated extension
//! calls need: `snapshot` (the registry entries) and `extension` (one
//! extension-point call with the options the TS call site passes).
//! [`DoorPlugins`] supplies a fresh `DoorCalls` per request for both the HTTP
//! serve door and the stdio door. B12-6 is the first runtime caller; until then
//! the door is exercised by tests only.
#![allow(dead_code)]

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_plugin_ops::extension::{EntriesFuture, ExtensionCalls};
use pacer_plugin_ops::public::Entry;
use serde_json::{Value, json};
use std::sync::Arc;

use super::plugins::CoreLink;
use crate::serve::core_child::CoreChild;
use crate::stdio_plugins::PluginLink;

/// The per-request carrier: an already-open HTTP link, a Core child to resolve
/// for one request, or a stdio link to the attached Core.
enum LinkSource {
    Ready(CoreLink),
    Http(Arc<CoreChild>),
    Stdio(Arc<PluginLink>),
}

/// The registry as [`ExtensionCalls`] sees it, carried over Core's private
/// plugin channel.
pub(crate) struct DoorCalls {
    link: LinkSource,
}

impl DoorCalls {
    pub(crate) fn new(link: CoreLink) -> Self {
        Self { link: LinkSource::Ready(link) }
    }

    pub(crate) fn http(core: Arc<CoreChild>) -> Self {
        Self { link: LinkSource::Http(core) }
    }

    pub(crate) fn stdio(link: Arc<PluginLink>) -> Self {
        Self { link: LinkSource::Stdio(link) }
    }

    async fn core_link(&self) -> Option<CoreLink> {
        match &self.link {
            LinkSource::Ready(link) => Some(link.clone()),
            LinkSource::Http(core) => super::plugins::http_link(core).await,
            LinkSource::Stdio(link) => Some((link.clone(), String::new())),
        }
    }
}

fn internal(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, e.to_string())
}

impl ExtensionCalls for DoorCalls {
    fn entries<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
        Box::pin(async move {
            let link = self.core_link().await.ok_or_else(|| internal("core plugin channel is not ready"))?;
            let mut entries = vec![];
            let _value = pacer_plugin_ops::ipc::request(
                &*link.0,
                &json!({"kind": "snapshot"}),
                &mut entries,
            )
            .await?;
            entries
                .iter()
                .cloned()
                .map(serde_json::from_value)
                .collect::<Result<Vec<Entry>, _>>()
                .map_err(internal)
        })
    }

    fn call<'a>(&'a mut self, _: &'a Ctx, id: &'a str, method: &'a str, params: Value) -> OpFuture<'a> {
        Box::pin(async move {
            let link = self.core_link().await.ok_or_else(|| internal("core plugin channel is not ready"))?;
            let mut entries = vec![];
            let value = pacer_plugin_ops::ipc::request(
                &*link.0,
                &json!({"kind": "extension", "id": id, "method": method, "params": params}),
                &mut entries,
            )
            .await?;
            Ok(value)
        })
    }
}

/// A `PluginDoor` for `pacer_status::usage`: each request gets a fresh
/// `DoorCalls`, so concurrent reads never share a response queue.
pub(crate) struct DoorPlugins {
    link: LinkSource,
}

impl DoorPlugins {
    pub(crate) fn http(core: Arc<CoreChild>) -> Self {
        Self { link: LinkSource::Http(core) }
    }

    pub(crate) fn stdio(link: Arc<PluginLink>) -> Self {
        Self { link: LinkSource::Stdio(link) }
    }
}

impl pacer_status::usage::PluginDoor for DoorPlugins {
    fn calls(&self) -> Box<dyn ExtensionCalls + '_> {
        let link = match &self.link {
            LinkSource::Ready(link) => LinkSource::Ready(link.clone()),
            LinkSource::Http(core) => LinkSource::Http(core.clone()),
            LinkSource::Stdio(link) => LinkSource::Stdio(link.clone()),
        };
        Box::new(DoorCalls { link })
    }
}
