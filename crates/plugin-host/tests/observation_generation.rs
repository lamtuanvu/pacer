#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{ObservationCall, ObservationGeneration, ReadContext, parse_manifest};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
#[test]
fn bootstrap_requires_negotiated_policy_or_doctor_call_and_read_owner_cannot_write() {
    let manifest=parse_manifest(json!({"id":"fx-observe","version":"1.0.0","publisher":"test","host":">=1.10.0","contributes":{"policy":{}},"capabilities":[{"name":"events.subscribe"},{"name":"tasks.read"}]})).unwrap();
    let alive = Arc::new(AtomicBool::new(true));
    let check = alive.clone();
    let context = ReadContext {
        home: "/fixture".into(),
        pacer_home: "/fixture/state".into(),
        env: Default::default(),
        now: 1.0,
    };
    let mut generation = ObservationGeneration::new(
        context,
        manifest,
        vec!["events.subscribe".into(), "tasks.read".into()],
        true,
        Arc::new(move || check.load(Ordering::SeqCst)),
    );
    let p = json!({"types":["task"]});
    let mut call = ObservationCall::new(
        "call".into(),
        Instant::now() + Duration::from_secs(5),
        vec!["events.subscribe".into(), "tasks.read".into()],
        false,
    );
    let request = json!({"id":1,"_meta":{"capabilityCall":"call"}});
    assert!(generation.subscribe(&p, &request, Some(&call), 10).is_err());
    call.bootstrap = true;
    let reply = generation.subscribe(&p, &request, Some(&call), 10).unwrap();
    let read = json!({"id":2,"_meta":{"readOwner":reply["readOwner"]}});
    assert!(
        generation
            .authorize("capability.tasks.read", &read, None)
            .is_ok()
    );
    assert!(
        generation
            .authorize("capability.process.spawn", &read, None)
            .is_err()
    );
    let mixed = json!({"id":2,"_meta":{"readOwner":reply["readOwner"],"capabilityCall":"call"}});
    assert!(
        generation
            .authorize("capability.tasks.read", &mixed, Some(&call))
            .is_err()
    );
    call.revoke();
    assert!(
        generation
            .authorize("capability.tasks.read", &read, None)
            .is_ok()
    );
    alive.store(false, Ordering::SeqCst);
    assert!(
        generation
            .authorize("capability.tasks.read", &read, None)
            .is_err()
    );
}
#[tokio::test]
async fn task_response_budget_uses_the_result_envelope_and_authorizes_twice() {
    use pacer_plugin_host::{BrokerError, MAX_LINE_BYTES, TaskProjection};
    use serde_json::Value;
    struct Projection {
        checks: std::cell::Cell<usize>,
        calls: usize,
    }
    impl TaskProjection for Projection {
        fn authorize(&self, _: &ReadContext, _: &str, _: &Value) -> Result<(), BrokerError> {
            self.checks.set(self.checks.get() + 1);
            Ok(())
        }
        async fn project(
            &mut self,
            _: ReadContext,
            method: &str,
            p: Value,
        ) -> Result<Value, BrokerError> {
            self.calls += 1;
            assert_eq!(method, "capability.tasks.read");
            assert_eq!(p["id"], "task");
            Ok(json!({"task":{"id":"task","state":"done","report":"x".repeat(2048)}}))
        }
    }
    let manifest=parse_manifest(json!({"id":"fx-task-read","version":"1.0.0","publisher":"test","host":">=1.10.0","capabilities":[{"name":"tasks.read"}]})).unwrap();
    let context = ReadContext {
        home: "/fixture".into(),
        pacer_home: "/fixture/state".into(),
        env: Default::default(),
        now: 1.0,
    };
    let mut generation = ObservationGeneration::new(
        context,
        manifest,
        vec!["tasks.read".into()],
        true,
        Arc::new(|| true),
    );
    let call = ObservationCall::new(
        "call".into(),
        Instant::now() + Duration::from_secs(5),
        vec!["tasks.read".into()],
        false,
    );
    let request =
        json!({"id":1,"_meta":{"capabilityCall":"call","extra":"x".repeat(MAX_LINE_BYTES-512)}});
    let mut projection = Projection {
        checks: std::cell::Cell::new(0),
        calls: 0,
    };
    assert!(
        generation
            .read(
                "capability.tasks.read",
                json!({"id":"task"}),
                &request,
                Some(&call),
                &mut projection
            )
            .await
            .is_ok()
    );
    assert_eq!(projection.calls, 1);
    assert_eq!(projection.checks.get(), 2);
    for params in [json!({"id":"task","path":"/foreign"}), json!({"id":""})] {
        assert!(
            generation
                .read(
                    "capability.tasks.read",
                    params,
                    &request,
                    Some(&call),
                    &mut projection
                )
                .await
                .is_err()
        );
    }
    assert_eq!(projection.calls, 1);
}
