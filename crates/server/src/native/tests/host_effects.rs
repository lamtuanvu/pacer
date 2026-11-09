#![allow(clippy::unwrap_used)]
use pacer_config_ops::host_check_clean_setup_ops::HostEffects;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

/// Fixture bridge that records every effect request and replies with a canned result.
struct RecordingBridge {
    requests: Vec<Value>,
    reply: Result<Value, CoreError>,
}

impl HostEffects for RecordingBridge {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.requests.push(request);
        let reply = self.reply.clone();
        Box::pin(async move { reply })
    }
}

#[tokio::test]
async fn host_check_routes_through_the_host_effects_bridge_when_supplied() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let op = registry.get("host.check").unwrap();
    // A marker error proves the request flowed through the bridge: the stub
    // would answer Unavailable "host effects bridge unavailable" instead.
    let mut bridge = RecordingBridge {
        requests: Vec::new(),
        reply: Err(CoreError::new(Code::Internal, "fixture probe refused")),
    };
    let error = crate::native::call_native(
        &ctx,
        op,
        json!({"alias": "myhost"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(&mut bridge),
    )
    .await
    .unwrap_err();
    assert_eq!(
        bridge.requests,
        vec![json!({"kind": "probe", "alias": "myhost"})]
    );
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(error.message, "fixture probe refused");
}

#[test]
fn host_check_clean_and_setup_stay_forwarded_until_core_has_a_bridge() {
    // No call site keeps these three ops native: over HTTP and stdio they stay
    // on the TypeScript path until Core has a real host effects bridge.
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    for op in ["host.check", "host.clean", "host.repo.setup"] {
        assert!(
            crate::native::host_stays_forwarded(&ctx, op, &json!({"alias": "myhost"})),
            "{op} must stay forwarded"
        );
    }
    assert!(!crate::native::host_stays_forwarded(
        &ctx,
        "host.list",
        &json!({})
    ));
    assert!(!crate::native::host_stays_forwarded(
        &ctx,
        "host.get",
        &json!({})
    ));
}

#[tokio::test]
async fn host_check_without_a_bridge_falls_back_to_the_stub_error() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let op = registry.get("host.check").unwrap();
    let error = crate::native::call_native(
        &ctx,
        op,
        json!({"alias": "myhost"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert_eq!(error.message, "host effects bridge unavailable");
}
