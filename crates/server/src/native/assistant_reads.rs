//! Native assistant turn wiring: read ops over the in-process registry and the
//! `assistant.reply` call through the native plugin owner's door.
//!
//! The bundled `assistant-pacer` plugin declares only door capabilities
//! (`capability.assistant.tool`, `capability.secrets.resolve`) and `net.http`,
//! which the capability session answers locally. Rust therefore answers every
//! capability of a turn; no Core capability channel is needed.

#![allow(clippy::result_large_err)]
use pacer_assistant_ops::assistant_ops::{
    live::TurnTools,
    run_turn::ReplyRunner,
    tools::ReadOps,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture, Registry},
};
use pacer_plugin_ops::ipc::{CoreIpc, request as ipc_request};
use pacer_plugin_runtime::{CoreRequest, SharedOwner, door_call::DOOR_METHODS};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};

/// The bundled reply plugin serving `backend: pacer`.
const REPLY_PLUGIN: &str = "assistant-pacer";

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

/// Read ops for a turn's tools and digest over the native registry. Read tools
/// only name read operations; any op that still needs a Core bridge answers
/// `unavailable`, which the digest and tool pipeline treat as a skipped read.
pub struct NativeReadOps;

impl ReadOps for NativeReadOps {
    fn read<'a>(&'a mut self, ctx: &'a Ctx, op: &'a str, params: Value) -> OpFuture<'a> {
        Box::pin(async move {
            let registry: Registry<'static> = crate::native::service_registry("");
            let entry = registry.get(op).ok_or_else(|| {
                CoreError::new(
                    Code::UnknownOp,
                    format!("unknown operation \"{op}\""),
                )
            })?;
            (entry.call)(ctx, params).await
        })
    }
}

pub type CoreLink = Arc<dyn CoreIpc>;
/// A door's private channel to its Core, created lazily for a call.
pub type CoreLinkFuture = Pin<Box<dyn Future<Output = Option<CoreLink>> + Send>>;

/// A door: the serve listener or a stdio connection provides its private Core
/// channel and its native plugin owner.
pub struct NativeReplyRunner {
    owner: SharedOwner,
    link: Arc<dyn Fn() -> CoreLinkFuture + Send + Sync>,
}

impl NativeReplyRunner {
    pub fn new(
        owner: SharedOwner,
        link: impl Fn() -> CoreLinkFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            owner,
            link: Arc::new(link),
        }
    }

    async fn sealed(
        &self,
        ctx: &Ctx,
        mut params: Value,
    ) -> Result<(Value, Value), CoreError> {
        let ipc = (self.link)().await.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let spawn = ipc_request(
            &*ipc,
            &json!({"kind":"spawn_spec","id":REPLY_PLUGIN}),
            &mut Vec::new(),
        )
        .await?;
        let authority = ipc_request(
            &*ipc,
            &json!({"kind":"call_authority","id":REPLY_PLUGIN,"method":"assistant.reply"}),
            &mut Vec::new(),
        )
        .await?;
        let object = params.as_object_mut().ok_or_else(|| unavailable("invalid assistant.reply params"))?;
        object.insert("spawn".into(), spawn);
        object.insert(
            "scopeRoots".into(),
            json!({
                "home": ctx.home,
                "pacerHome": ctx.pacer_home,
                "accountHome": null
            }),
        );
        object.insert("coreMethods".into(), json!(DOOR_METHODS));
        Ok((params, authority))
    }
}

impl ReplyRunner for NativeReplyRunner {
    fn reads(&self) -> Box<dyn ReadOps> {
        Box::new(NativeReadOps)
    }

    fn reply<'a>(
        &'a self,
        ctx: &'a Ctx,
        params: Value,
        tools: Arc<TurnTools>,
        cancel: watch::Receiver<bool>,
        deadline: Duration,
    ) -> OpFuture<'a> {
        Box::pin(async move {
            let (sealed, authority) = self.sealed(ctx, params).await?;
            let (door, mut door_requests) = mpsc::channel::<CoreRequest>(8);
            let door_ctx = ctx.clone();
            let door_tools = Arc::clone(&tools);
            let door_task = tokio::spawn(async move {
                while let Some((method, body, reply)) = door_requests.recv().await {
                    let answer = match method.as_str() {
                        "capability.assistant.tool" => {
                            let mut reads = NativeReadOps;
                            let (content, ok) = door_tools.call(&door_ctx, &body, &mut reads).await;
                            Ok(json!({"name":body["name"].as_str().unwrap_or(""),"content":content,"ok":ok}))
                        }
                        "capability.secrets.resolve" => door_tools
                            .secret(&door_ctx, REPLY_PLUGIN, body["ref"].as_str().unwrap_or(""))
                            .map_err(|error| json!({"code":error.code,"message":error.message})),
                        _ => Err(json!({"code":"capability_denied","message":format!("{method} is not a door capability")})),
                    };
                    let _ = reply.send(answer);
                }
            });
            // No Core capability is needed by the pacer backend; refuse any
            // method that somehow reaches the Core channel.
            let (core, mut core_requests) = mpsc::channel::<CoreRequest>(8);
            let core_task = tokio::spawn(async move {
                while let Some((method, _body, reply)) = core_requests.recv().await {
                    let _ = reply.send(Err(json!({
                        "code": "capability_denied",
                        "message": format!("{method} is not answered by the assistant turn")
                    })));
                }
            });
            let result = pacer_plugin_runtime::door_call::call_with_door_capabilities(
                &self.owner,
                REPLY_PLUGIN,
                "assistant.reply",
                sealed,
                authority,
                &DOOR_METHODS,
                door,
                core,
                deadline,
                Some(&cancel),
            )
            .await;
            door_task.abort();
            core_task.abort();
            result.map_err(|error| {
                let mut next = CoreError::new(
                    match error.code.as_str() {
                        "plugin_timeout" => Code::PluginTimeout,
                        "plugin_unavailable" => Code::PluginUnavailable,
                        "capability_denied" => Code::CapabilityDenied,
                        "invalid_input" => Code::InvalidInput,
                        _ => Code::PluginRefused,
                    },
                    error.message,
                );
                if let Some(hint) = error.hint.filter(|hint| !hint.is_empty()) {
                    next = next.hint(hint);
                }
                next
            })
        })
    }
}

/// Trace a native turn op, like the other native mutations.
pub fn trace(op: &str) {
    if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
        eprintln!("native {op}");
    }
}
