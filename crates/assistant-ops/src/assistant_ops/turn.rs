//! Native `assistant.ask` and `assistant.cancel`. Rust applies the caller policy and the Zod
//! params, then hands the turn to Core: the plugin call, the live-turn map and the answer stream
//! at `/v3/assistant/turns/<turnId>/stream` belong to the TypeScript process that runs the turn
//! (`src/api/assistant-turn-bridge.ts`).
use super::params::{Params, parse};
use super::{refuse, unavailable};
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::{Value, json};

/// Core's side of a turn operation: `{"op","params"}` with validated params.
pub trait TurnBridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

pub fn needs_turn_bridge(op: &str) -> bool {
    matches!(op, "assistant.ask" | "assistant.cancel")
}

/// The bridge request for `op`, after the refusals TypeScript makes ahead of the handler.
fn request(ctx: &Ctx, op: &str, params: Value) -> Result<Value, CoreError> {
    refuse(ctx)?;
    let params = match parse(op, params)? {
        Params::Ask(ask) => ask,
        Params::Id(turn) => json!({"turnId": turn}),
        _ => return Err(unavailable("assistant turn bridge unavailable")),
    };
    Ok(json!({"op": op, "params": params}))
}

/// Run `op` through the door's Core bridge.
pub fn call<'a>(
    ctx: &'a Ctx,
    op: &'a str,
    params: Value,
    bridge: &'a mut dyn TurnBridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        let request = request(ctx, op, params)?;
        bridge.call(request).await
    })
}

/// A registry entry without a Core channel: it answers every refusal, and only a door can run the turn.
fn without_bridge<'a>(ctx: &'a Ctx, op: &'static str, params: Value) -> OpFuture<'a> {
    Box::pin(async move {
        request(ctx, op, params)?;
        Err(unavailable("assistant turn bridge unavailable"))
    })
}

pub fn assistant_ask(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    without_bridge(ctx, "assistant.ask", params)
}

pub fn assistant_cancel(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    without_bridge(ctx, "assistant.cancel", params)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use pacer_foundation::api::Code;

    #[derive(Default)]
    struct Recording(Vec<Value>);
    impl TurnBridge for Recording {
        fn call(&mut self, request: Value) -> OpFuture<'_> {
            self.0.push(request);
            Box::pin(async { Ok(json!({"conversationId": "c", "turnId": "t"})) })
        }
    }

    fn ctx(dir: &std::path::Path, env: &[(&str, &str)]) -> Ctx {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Ctx::with(dir.to_path_buf(), dir.to_path_buf(), env, 0.0)
    }

    #[tokio::test]
    async fn valid_params_cross_the_bridge_in_their_parsed_form() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path(), &[]);
        let mut bridge = Recording::default();
        let params =
            json!({"text": "hi", "scope": {"kind": "dispatch", "x": 1}, "requestId": "r", "y": 2});
        call(&ctx, "assistant.ask", params, &mut bridge)
            .await
            .unwrap();
        call(
            &ctx,
            "assistant.cancel",
            json!({"turnId": "t", "y": 2}),
            &mut bridge,
        )
        .await
        .unwrap();
        assert_eq!(
            bridge.0,
            [
                json!({"op": "assistant.ask", "params": {"text": "hi", "scope": {"kind": "dispatch", "days": 7}, "requestId": "r"}}),
                json!({"op": "assistant.cancel", "params": {"turnId": "t"}}),
            ]
        );
    }

    #[tokio::test]
    async fn refusals_never_reach_core() {
        let dir = tempfile::tempdir().unwrap();
        let mut bridge = Recording::default();
        let plain = ctx(dir.path(), &[]);
        let invalid = call(&plain, "assistant.cancel", json!({}), &mut bridge)
            .await
            .unwrap_err();
        assert_eq!(invalid.code, Code::InvalidInput);
        let executor = ctx(dir.path(), &[("PACER_ROLE", "executor")]);
        let refused = call(&executor, "assistant.ask", json!({}), &mut bridge)
            .await
            .unwrap_err();
        assert_eq!(refused.code, Code::NotAllowed);
        assert!(bridge.0.is_empty());
    }
}
