//! Server effects for native `dispatch.refresh` (B2-12): the full status read
//! and plugin `observation.observe` calls travel the same sealed Core channels
//! the other native dispatch effects use.
//!
//! The observation-plugin list is supplied by the door rather than fetched in
//! the constructor: the stdio door's private plugin channel is pumped by the
//! same loop that dispatches the operation, so awaiting a plugin reply there
//! would deadlock. Doors that can reach the registry without that loop pass
//! the enabled `observation` contributors in.
#![allow(clippy::result_large_err)]
use crate::native::{plugins as native_plugins, status_sync};
use pacer_dispatch_ops::refresh_effects::RefreshEffects;
use pacer_foundation::{
    api::{Code, CoreError, OpFuture},
};
use pacer_plugin_ops::ipc::CoreIpc;
use serde_json::Value;
use std::{marker::Unpin, sync::Arc, time::Duration};
use tokio::{io::AsyncWrite, sync::mpsc::UnboundedReceiver};

/// How this door reaches the status owner's full `computeStatus` read.
pub(crate) enum StatusSource<'a, W> {
    Http(Option<(u16, String)>),
    Stdio {
        core: &'a mut W,
        prefix: &'a str,
        key: &'a str,
        replies: &'a mut UnboundedReceiver<Value>,
    },
}

/// Native refresh effects bound to one request on one front door.
pub(crate) struct NativeRefreshEffects<'a, W> {
    status: Option<StatusSource<'a, W>>,
    service: &'a native_plugins::Service,
    core: (Arc<dyn CoreIpc>, String),
    plugins: Vec<String>,
    timeout: Duration,
}

impl<'a, W: AsyncWrite + Unpin + Send> NativeRefreshEffects<'a, W> {
    pub(crate) fn new(
        status: StatusSource<'a, W>,
        service: &'a native_plugins::Service,
        core: (Arc<dyn CoreIpc>, String),
        plugins: Vec<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            status: Some(status),
            service,
            core,
            plugins,
            timeout,
        }
    }
}

impl<W: AsyncWrite + Unpin + Send> RefreshEffects for NativeRefreshEffects<'_, W> {
    fn status(&mut self) -> OpFuture<'_> {
        let source = self.status.take().ok_or_else(|| {
            CoreError::new(Code::Unavailable, "status was already read for this refresh")
        });
        Box::pin(async move {
            match source? {
                StatusSource::Http(target) => status_sync::http(target, serde_json::json!({})).await,
                StatusSource::Stdio {
                    core,
                    prefix,
                    key,
                    replies,
                } => status_sync::stdio(core, prefix, key, serde_json::json!({}), replies).await,
            }
        })
    }

    fn observe(&mut self, plugin: &str, input: Value) -> OpFuture<'_> {
        let service = self.service;
        let core = self.core.clone();
        let plugin = plugin.to_owned();
        let timeout = self.timeout;
        Box::pin(async move {
            let call =
                service.call_method(async move { Some(core) }, &plugin, "observation.observe", input);
            tokio::time::timeout(timeout, call)
                .await
                .map_err(|_| CoreError::new(Code::Unavailable, "observation timed out"))?
        })
    }

    fn observation_plugins(&self) -> Vec<String> {
        self.plugins.clone()
    }
}
