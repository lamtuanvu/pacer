#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{BrokerError, PolicyCaller, PolicyEntry, PolicySnapshot, evaluate_policy};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
struct Caller {
    replies: VecDeque<Value>,
    calls: Vec<String>,
    slow: bool,
}
impl PolicyCaller for Caller {
    async fn call(
        &mut self,
        id: &str,
        _params: Value,
        _deadline: Instant,
    ) -> Result<Value, BrokerError> {
        self.calls.push(id.into());
        if self.slow {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        Ok(self
            .replies
            .pop_front()
            .unwrap_or(json!({"verdict":"allow"})))
    }
}
fn snapshot(closed: bool) -> PolicySnapshot {
    PolicySnapshot {
        closed,
        fingerprint: "generation".into(),
        policies: vec![
            PolicyEntry {
                id: "policy-b".into(),
                generation: "b1".into(),
            },
            PolicyEntry {
                id: "policy-a".into(),
                generation: "a1".into(),
            },
        ],
        unavailable: vec![],
    }
}
#[tokio::test]
async fn sorted_policy_calls_and_receipts_enforce_context_and_no_executor_or_isolation_downgrade() {
    let mut caller = Caller {
        replies: VecDeque::from([
            json!({"verdict":"amend","amend":{"exclude":["runner-a"]}}),
            json!({"verdict":"allow"}),
        ]),
        calls: vec![],
        slow: false,
    };
    let receipt = evaluate_policy(
        snapshot(true),
        json!({"decision":"route","input":{"taskId":"t-x","candidates":["runner-a","runner-b"]}}),
        &mut caller,
        Instant::now() + Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert_eq!(caller.calls, ["policy-a", "policy-b"]);
    assert_eq!(receipt.params["input"]["candidates"], json!(["runner-b"]));
    assert_eq!(receipt.excluded_by["runner-a"], "policy-a");
    assert!(receipt.revalidate("changed").is_err());
    assert!(receipt.revalidate("generation").is_ok());
}
#[tokio::test]
async fn shared_budget_stops_later_calls_and_closed_mode_cannot_ignore_failures() {
    for closed in [true, false] {
        let mut caller = Caller {
            replies: VecDeque::new(),
            calls: vec![],
            slow: true,
        };
        let result = evaluate_policy(
            snapshot(closed),
            json!({"decision":"route","input":{"taskId":"t-x","candidates":[]}}),
            &mut caller,
            Instant::now() + Duration::from_millis(20),
        )
        .await;
        assert_eq!(caller.calls, ["policy-a"]);
        if closed {
            assert!(result.is_err());
        } else {
            assert!(result.is_ok());
        }
    }
    let mut s = snapshot(true);
    s.unavailable
        .push(("legacy-unreadable".into(), "manifest is unreadable".into()));
    let mut caller = Caller {
        replies: VecDeque::new(),
        calls: vec![],
        slow: false,
    };
    assert!(
        evaluate_policy(
            s,
            json!({"decision":"route","input":{"taskId":"t-x","candidates":[]}}),
            &mut caller,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .is_err()
    );
    assert!(caller.calls.is_empty());
}
