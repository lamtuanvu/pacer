//! The serve door's view of the plugin registry as a native op needs it, before
//! B0c moves the registry into Rust. [`DoorCalls`] talks to Core's private
//! `/_internal/plugins` channel with the two kinds host-originated extension
//! calls need: `snapshot` (the registry entries) and `extension` (one
//! extension-point call with the options the TS call site passes).

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_plugin_ops::extension::{EntriesFuture, ExtensionCalls};
use pacer_plugin_ops::public::Entry;
use serde_json::{Value, json};

use super::plugins::CoreLink;

/// The registry as [`ExtensionCalls`] sees it, carried over Core's private
/// plugin channel. No host flow constructs it yet in this slice; consumers add
/// the extension methods (G2), so the door is exercised by tests until then.
#[allow(dead_code)]
pub(crate) struct DoorCalls {
    link: CoreLink,
}

#[allow(dead_code)]
fn internal(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, e.to_string())
}

#[allow(dead_code)]
impl DoorCalls {
    pub(crate) fn new(link: CoreLink) -> Self {
        Self { link }
    }
}

impl ExtensionCalls for DoorCalls {
    fn entries<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
        Box::pin(async move {
            let mut entries = vec![];
            let _value = pacer_plugin_ops::ipc::request(&*self.link.0, &json!({"kind": "snapshot"}), &mut entries)
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
            let mut entries = vec![];
            let value = pacer_plugin_ops::ipc::request(
                &*self.link.0,
                &json!({"kind": "extension", "id": id, "method": method, "params": params}),
                &mut entries,
            )
            .await?;
            Ok(value)
        })
    }
}