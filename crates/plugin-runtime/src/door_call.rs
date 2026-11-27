//! Door-initiated sealed calls with split capability forwarding.
//!
//! A door (the native front end) seals `call_authority` exactly as Core seals
//! it for its own calls ([`crate::bridge_call`]), but the capability session
//! forwards `door_methods` — here `capability.assistant.tool` and
//! `capability.secrets.resolve` — to `door` instead of `core`. Everything else
//! Core answers (`capability.identity.sign`, and the rest of
//! [`crate::core_capability`]) still goes to `core`. The routing is a small
//! dispatcher channel in front of the sealed call, so the broker sees one
//! `CoreForward` and no extra trust boundary is introduced.

use crate::{
    CallFailure, CoreForward, CoreRequest,
    bridge_call::{SealedCall, call_sealed},
    bridge_listener::SharedOwner,
    capability::core_capability,
};
use serde_json::Value;
use std::{
    collections::HashSet,
    fmt::Display,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

fn invalid(error: impl Display) -> CallFailure {
    CallFailure {
        code: "invalid_input".to_owned(),
        message: error.to_string(),
        hint: None,
        from_plugin: false,
    }
}

/// Call a plugin already held by the owner (or started by the sealed params),
/// answering its capability requests from two independent channels.
///
/// `params` carries the sealed call shape (`spawn`, `scopeRoots`, `hello`,
/// `coreMethods`): the door holds the same spawn authority Core would have
/// sealed. `authority` is the `call_authority` body. `door_methods` are routed
/// to `door`; every other Core-sealed method goes to `core`. `cancel`, when
/// present, cancels the child exchange; `deadline` is absolute from the call.
#[allow(clippy::too_many_arguments)]
pub async fn call_with_door_capabilities(
    owner: &SharedOwner,
    id: &str,
    method: &str,
    params: Value,
    authority: Value,
    door_methods: &[&str],
    door: CoreForward,
    core: CoreForward,
    deadline: Duration,
    cancel: Option<&watch::Receiver<bool>>,
) -> Result<Value, CallFailure> {
    let door_set: HashSet<String> = door_methods.iter().map(|m| (*m).to_owned()).collect();

    // Seal the same way as `bridge_call`: the authority body and the methods
    // the broker must forward come from the door, never from the child. A door
    // method still has to be `core_capability`-sealed so the session forwards
    // it instead of answering it from its own broker.
    let mut sealed_params = params.clone();
    sealed_params["authority"] = authority;
    let mut core_methods: Vec<Value> = sealed_params
        .get("coreMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|method| {
            method
                .as_str()
                .and_then(core_capability)
                .is_some()
        })
        .collect();
    for name in door_methods {
        if core_capability(name).is_some()
            && !core_methods.iter().any(|m| m.as_str() == Some(*name))
        {
            core_methods.push(Value::String((*name).to_owned()));
        }
    }
    sealed_params["coreMethods"] = Value::Array(core_methods);
    let sealed = SealedCall::from_params(&sealed_params)
        .map_err(invalid)?
        .ok_or_else(|| invalid("a door call requires sealed spawn and scope roots"))?;

    // One channel for the broker; a dispatcher sends each request to the door
    // or to Core. Requests and replies are the existing `CoreRequest` tuple,
    // so neither channel needs to know about the other.
    let (router, mut requests) = mpsc::channel::<CoreRequest>(1);
    let dispatcher = tokio::spawn(async move {
        while let Some((name, body, reply)) = requests.recv().await {
            let destination = if door_set.contains(&name) {
                &door
            } else {
                &core
            };
            // A closed destination means its owner is gone; dropping the reply
            // surfaces as a capability refusal to the child, never a hang.
            let _ = destination.send((name, body, reply)).await;
        }
    });

    let (keep_alive, idle) = watch::channel(false);
    let cancel = cancel.unwrap_or(&idle);
    let until = Instant::now() + deadline;
    let result = call_sealed(owner, id, method, params, until, cancel, sealed, Some(router)).await;
    dispatcher.abort();
    drop(keep_alive);
    result
        .map(|reply| reply["value"].clone())
        .map_err(|boxed| boxed.0)
}

/// The methods this slice routes to the door rather than Core.
pub const DOOR_METHODS: [&str; 2] = ["capability.assistant.tool", "capability.secrets.resolve"];

/// `true` when a method is a door capability. Kept here so callers and tests
/// agree on the split without repeating the list.
pub fn is_door_method(method: &str) -> bool {
    DOOR_METHODS.contains(&method)
}

/// Re-exported for drivers that need to build the split channel pair.
pub use crate::capability::CoreRequest as DoorRequest;
