#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{BrokerError, PairingCandidate, PairingRegistry, handover_pairing};
use serde_json::{Value, json};
use std::{collections::VecDeque, time::Duration};
struct Registry {
    replies: VecDeque<Value>,
    calls: Vec<String>,
    logs: Vec<String>,
    slow: bool,
}
impl PairingRegistry for Registry {
    async fn start(
        &mut self,
        id: &str,
        params: Value,
        _budget: Duration,
    ) -> Result<Value, BrokerError> {
        self.calls.push(id.into());
        assert_eq!(params["hints"], "port=7");
        if self.slow {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let r = self.replies.pop_front().unwrap_or(Value::Null);
        if r == "error" {
            return Err(BrokerError::Effect("synthetic failure".into()));
        }
        Ok(r)
    }
    fn log(&mut self, id: &str, message: &str) {
        self.logs.push(format!("{id}: {message}"));
    }
}
fn candidates() -> Vec<PairingCandidate> {
    [
        ("off", false, true),
        ("other", true, false),
        ("broken", true, true),
        ("good", true, true),
    ]
    .into_iter()
    .map(|(id, enabled, pairing)| PairingCandidate {
        id: id.into(),
        enabled,
        pairing,
    })
    .collect()
}
#[tokio::test]
async fn pairing_skips_disabled_and_invalid_replies_and_hands_over_to_first_accepting_plugin() {
    for bad in [
        json!("error"),
        json!({"bogus":1}),
        json!({"accepted":"yes"}),
        json!({"accepted":false}),
    ] {
        let mut r = Registry {
            replies: VecDeque::from([bad, json!({"accepted":true,"ignored":1})]),
            calls: vec![],
            logs: vec![],
            slow: false,
        };
        let result = handover_pairing(
            &candidates(),
            json!({"discoveryId":"a".repeat(26),"name":"studio","hints":"port=7"}),
            &mut r,
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(result, json!({"handedOver":true,"plugin":"good"}));
        assert_eq!(r.calls, ["broken", "good"]);
    }
}
#[tokio::test]
async fn slow_plugin_consumes_shared_budget_and_next_plugin_is_not_called() {
    let mut r = Registry {
        replies: VecDeque::from([json!({"accepted":true})]),
        calls: vec![],
        logs: vec![],
        slow: true,
    };
    assert_eq!(
        handover_pairing(
            &candidates(),
            json!({"hints":"port=7"}),
            &mut r,
            Duration::from_millis(20)
        )
        .await,
        json!({"handedOver":false})
    );
    assert_eq!(r.calls, ["broken"]);
    assert!(r.logs[0].contains("time budget"));
}
#[tokio::test]
async fn successful_pair_persists_private_receipt_without_overwriting_radio_updates() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let home = std::env::temp_dir().join(format!("pacer-pair-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::create_dir(home.join("discovery")).unwrap();
    fs::write(
        home.join("discovery/state.json"),
        serde_json::to_vec(
            &json!({"rev":4,"seen":{"found":{"name":"newer radio value"}},"networksRev":2}),
        )
        .unwrap(),
    )
    .unwrap();
    let mut r = Registry {
        replies: VecDeque::from([json!({"accepted":true})]),
        calls: vec![],
        logs: vec![],
        slow: false,
    };
    pacer_plugin_host::pair(
        &home,
        &candidates(),
        json!({"discoveryId":"found","hints":"port=7"}),
        &mut r,
        Duration::from_secs(1),
        20.0,
        false,
    )
    .await
    .unwrap();
    let state: Value =
        serde_json::from_slice(&fs::read(home.join("discovery/state.json")).unwrap()).unwrap();
    assert_eq!(state["seen"]["found"]["name"], "newer radio value");
    assert_eq!(state["seen"]["found"]["handedOverAt"].as_f64(), Some(20.0));
    assert_eq!(state["rev"].as_f64(), Some(5.0));
    assert_eq!(
        fs::metadata(home.join("discovery/state.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    fs::remove_dir_all(home).unwrap();
}
