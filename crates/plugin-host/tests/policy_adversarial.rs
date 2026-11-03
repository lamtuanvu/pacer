#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    BrokerError, PolicyCaller, PolicyCancellation, PolicyEntry, PolicyOptions, PolicySnapshot,
    evaluate_policy_with,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
struct Caller {
    replies: VecDeque<Value>,
    seen: Vec<Value>,
    failures: Vec<String>,
    slow: bool,
}
impl PolicyCaller for Caller {
    async fn call(
        &mut self,
        _id: &str,
        p: Value,
        _deadline: Instant,
    ) -> Result<Value, BrokerError> {
        self.seen.push(p);
        if self.slow {
            std::future::pending::<()>().await;
        }
        Ok(self
            .replies
            .pop_front()
            .unwrap_or(json!({"verdict":"allow"})))
    }
    fn failure(&mut self, id: &str, _reason: &str) {
        self.failures.push(id.into());
    }
}
fn caller(replies: Vec<Value>) -> Caller {
    Caller {
        replies: replies.into(),
        seen: vec![],
        failures: vec![],
        slow: false,
    }
}
fn snapshot(closed: bool) -> PolicySnapshot {
    PolicySnapshot {
        closed,
        fingerprint: "generation".into(),
        policies: ["z", "a"]
            .map(|id| PolicyEntry {
                id: id.into(),
                generation: "1".into(),
            })
            .to_vec(),
        unavailable: vec![],
    }
}
fn delegate() -> Value {
    json!({"decision":"delegate","input":{"goal":"work","repo":"repo","kind":null,"requestedExecutor":null,"placement":"auto"}})
}
fn options() -> PolicyOptions<'static> {
    PolicyOptions {
        eligible_runners: &[],
        allowed_placements: &[],
        ..Default::default()
    }
}
fn budget() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
#[tokio::test]
async fn cancellation_stops_uncooperative_policy_in_open_mode_and_revokes_final_receipt() {
    let cancel = PolicyCancellation::default();
    let mut c = caller(vec![]);
    c.slow = true;
    let options = PolicyOptions {
        cancellation: Some(cancel.clone()),
        ..Default::default()
    };
    let work = evaluate_policy_with(snapshot(false), delegate(), &mut c, budget(), options);
    let stop = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(work, stop);
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert_eq!(c.seen.len(), 1);
    let mut c = caller(vec![]);
    let cancel = PolicyCancellation::default();
    let receipt = evaluate_policy_with(
        snapshot(false),
        delegate(),
        &mut c,
        budget(),
        PolicyOptions {
            cancellation: Some(cancel.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    cancel.cancel();
    assert!(receipt.revalidate("generation").is_err());
    let mut c = caller(vec![]);
    assert!(
        evaluate_policy_with(
            snapshot(false),
            delegate(),
            &mut c,
            budget(),
            PolicyOptions {
                cancellation: Some(cancel),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    assert!(c.seen.is_empty());
}
#[tokio::test]
async fn schema_rejects_wrong_optional_metadata_and_snapshot_uses_utf16_limits() {
    for (key, value) in [
        ("goalLength", json!(-1)),
        ("goalHash", json!("short")),
        ("repoKey", json!(false)),
    ] {
        let mut input = delegate();
        input["input"][key] = value;
        assert!(
            evaluate_policy_with(
                snapshot(false),
                input,
                &mut caller(vec![]),
                budget(),
                options()
            )
            .await
            .is_err()
        );
    }
    let mut s = snapshot(false);
    s.policies[0].id = "😀".repeat(65);
    assert!(
        evaluate_policy_with(s, delegate(), &mut caller(vec![]), budget(), options())
            .await
            .is_err()
    );
    for value in [
        json!({"kind":"invented"}),
        json!({"executor":""}),
        json!({"noteHash":"short"}),
        json!({"noteLength":null}),
    ] {
        let mut input = json!({"decision":"review","input":{"taskId":"task","revision":1,"state":"done","verdict":"accept"}});
        input["input"]
            .as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        assert!(
            evaluate_policy_with(
                snapshot(false),
                input,
                &mut caller(vec![]),
                budget(),
                options()
            )
            .await
            .is_err()
        );
    }
}
#[tokio::test]
async fn all_amendments_are_strict_cumulative_and_cannot_steer_or_weaken_isolation() {
    for amend in [
        json!({"goal":"replace"}),
        json!({"requestedExecutor":"runner"}),
        json!({"placement":"current"}),
        json!({"kind":"invented"}),
    ] {
        for closed in [true, false] {
            let mut c = caller(vec![json!({"verdict":"amend","amend":amend}); 2]);
            let result = evaluate_policy_with(
                snapshot(closed),
                delegate(),
                &mut c,
                budget(),
                PolicyOptions {
                    eligible_runners: &["runner".into()],
                    allowed_placements: &["new".into(), "current".into(), "auto".into()],
                    validate_delegate: Some(&|_| true),
                    ..Default::default()
                },
            )
            .await;
            if closed {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap().params, delegate());
                assert_eq!(c.failures, ["a", "z"]);
            }
        }
    }
    let mut c = caller(vec![
        json!({"verdict":"amend","amend":{"placement":"new"}}),
        json!({"verdict":"amend","amend":{"kind":"tests"}}),
    ]);
    let r = evaluate_policy_with(
        snapshot(true),
        delegate(),
        &mut c,
        budget(),
        PolicyOptions {
            allowed_placements: &["new".into()],
            validate_delegate: Some(&|_| true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(c.seen[1]["input"]["placement"], "new");
    assert_eq!(r.params["input"]["kind"], "tests");
}
#[tokio::test]
async fn context_changes_never_follow_open_failure_mode_and_cannot_dispatch_later_policies() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let current = Arc::new(move || {
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            "generation".into()
        } else {
            "changed".into()
        }
    });
    let mut c = caller(vec![]);
    assert!(
        evaluate_policy_with(
            snapshot(false),
            delegate(),
            &mut c,
            budget(),
            PolicyOptions {
                current_fingerprint: Some(current),
                ..Default::default()
            }
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("changed")
    );
    assert_eq!(c.seen.len(), 1);
}
#[tokio::test]
async fn serialized_oversize_follows_frozen_mode_and_never_truncates_candidate_sets() {
    let input = json!({"decision":"route","input":{"taskId":"task","candidates":vec!["x".repeat(128);10000]}});
    for closed in [false, true] {
        let mut c = caller(vec![]);
        let result =
            evaluate_policy_with(snapshot(closed), input.clone(), &mut c, budget(), options())
                .await;
        if closed {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap().params, input);
            assert_eq!(c.failures, ["a", "z"]);
        }
        assert!(c.seen.is_empty());
    }
}
#[test]
fn registry_fingerprint_binds_grants_config_and_context_but_not_lazy_process_state() {
    use pacer_plugin_host::{PluginsConfig, Registry, parse_manifest};
    let mut registry = Registry::shadow();
    let manifest=parse_manifest(json!({"id":"fx-policy","publisher":"fixture","version":"1.0.0","host":">=1.10.0","contributes":{"policy":{}}})).unwrap();
    registry.insert(manifest, false, true);
    let config: PluginsConfig = serde_json::from_value(
        json!({"installed":{"fx-policy":{"version":"1.0.0","capabilities":[],"policy":true}}}),
    )
    .unwrap();
    let (a, access) = registry.policy_context(&config, "task revision 1").unwrap();
    assert_eq!(a.policies.len(), 1);
    assert!(!access["fx-policy"].bundled);
    registry.crash("fx-policy", 1).unwrap();
    let (b, _) = registry.policy_context(&config, "task revision 1").unwrap();
    assert_eq!(a.fingerprint, b.fingerprint);
    let (c, _) = registry.policy_context(&config, "task revision 2").unwrap();
    assert_ne!(a.fingerprint, c.fingerprint);
    let mut changed = config.clone();
    changed.config.insert(
        "fx-policy".into(),
        std::collections::HashMap::from([("policy".into(), json!("changed"))]),
    );
    assert_ne!(
        a.fingerprint,
        registry
            .policy_context(&changed, "task revision 1")
            .unwrap()
            .0
            .fingerprint
    );
}
#[tokio::test]
async fn tracing_sink_panics_do_not_change_open_policy_result() {
    struct Sink;
    impl PolicyCaller for Sink {
        async fn call(&mut self, _: &str, _: Value, _: Instant) -> Result<Value, BrokerError> {
            Err(BrokerError::Timeout)
        }
        fn failure(&mut self, _: &str, _: &str) {
            panic!("trace failure");
        }
    }
    assert!(
        evaluate_policy_with(snapshot(false), delegate(), &mut Sink, budget(), options())
            .await
            .is_ok()
    );
}
#[test]
fn refreshed_policy_metadata_refuses_revoked_capabilities_before_lazy_start() {
    use pacer_plugin_host::{PluginsConfig, Registry, parse_manifest};
    let mut registry = Registry::shadow();
    registry.insert(parse_manifest(json!({"id":"fx-policy","publisher":"test","version":"1.0.0","host":">=1.10.0","contributes":{"policy":{}},"capabilities":[{"name":"tasks.read"}]})).unwrap(),false,true);
    let config:PluginsConfig=serde_json::from_value(json!({"policy":{"mode":"closed"},"installed":{"fx-policy":{"version":"1.0.0","capabilities":[],"policy":true}}})).unwrap();
    let (snapshot, _) = registry.policy_context(&config, "context").unwrap();
    assert!(snapshot.policies.is_empty());
    assert_eq!(
        snapshot.unavailable,
        vec![("fx-policy".into(), "needs_grant".into())]
    );
}
