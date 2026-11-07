#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

const ID: &str = "abcdefghijklmnopqrstuvwxyz";
const NET: &str = "0123456789abcdef0123456789abcdef";

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1000.0,
    )
}

fn write(dir: &tempfile::TempDir, text: &str) {
    fs::create_dir_all(dir.path().join("discovery")).unwrap();
    fs::write(dir.path().join("discovery/state.json"), text).unwrap();
}

fn read(dir: &tempfile::TempDir) -> String {
    fs::read_to_string(dir.path().join("discovery/state.json")).unwrap()
}

fn found() -> Value {
    json!({
        "rev": 4, "networksRev": 2, "enabled": true, "extra": "kept",
        "networks": {NET: {"label": "Home", "advertise": null, "discoveryId": ID, "muted": false}},
        "silenced": {}, "seen": {ID: {"discoveryId": ID, "name": "peer", "network": NET, "lastSeen": 5}},
        "prompts": [1]
    })
}

async fn error(future: OpFuture<'_>) -> (Code, String) {
    let error = future.await.unwrap_err();
    (error.code, error.message)
}

#[tokio::test]
async fn set_creates_state_and_counts_settings_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let value = discovery_set(&c, json!({"enabled": false})).await.unwrap();
    assert_eq!(value, json!({"enabled": false, "rev": 1, "networksRev": 1}));
    assert_eq!(
        read(&dir),
        "{\n  \"rev\": 1,\n  \"networksRev\": 1,\n  \"enabled\": false,\n  \"networks\": {},\n  \"silenced\": {},\n  \"seen\": {},\n  \"prompts\": []\n}\n"
    );
    // The same value moves rev but not networksRev.
    let value = discovery_set(&c, json!({"enabled": false, "expect_rev": 1}))
        .await
        .unwrap();
    assert_eq!(value, json!({"enabled": false, "rev": 2, "networksRev": 1}));
    let stale = discovery_set(&c, json!({"enabled": true, "expect_rev": 0}))
        .await
        .unwrap_err();
    assert_eq!(stale.code, Code::Conflict);
    assert_eq!(
        stale.message,
        "Discovery settings changed in another client"
    );
    assert_eq!(stale.hint.as_deref(), Some("Reload and try again."));
}

#[tokio::test]
async fn set_preserves_unknown_fields_and_recovers_corrupt_documents() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    write(&dir, r#"{"extra":1,"enabled":"no","corrupt":true,"rev":7}"#);
    discovery_set(&c, json!({"enabled": true})).await.unwrap();
    let doc: Value = serde_json::from_str(&read(&dir)).unwrap();
    let keys: Vec<_> = doc.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "rev",
            "networksRev",
            "enabled",
            "networks",
            "silenced",
            "seen",
            "prompts",
            "extra"
        ]
    );
    assert_eq!(doc["rev"], json!(8));
    assert_eq!(doc["networksRev"], json!(0));
    write(&dir, "[]");
    let value = discovery_set(&c, json!({"enabled": true})).await.unwrap();
    assert_eq!(value, json!({"enabled": true, "rev": 1, "networksRev": 1}));
}

#[tokio::test]
async fn respond_silences_ignores_and_mutes() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    write(&dir, &serde_json::to_string(&found()).unwrap());
    let ok = json!({"ok": true});
    let later = json!({"discoveryId": ID, "action": "later"});
    assert_eq!(discovery_respond(&c, later).await.unwrap(), ok);
    let doc: Value = serde_json::from_str(&read(&dir)).unwrap();
    let until = doc["silenced"][ID].as_i64().unwrap();
    assert!((until - unix_now() as i64 - SILENCE_LATER_S).abs() <= 2);
    assert_eq!(doc["networksRev"], json!(2));
    let ignore = json!({"discoveryId": ID, "action": "ignore"});
    discovery_respond(&c, ignore).await.unwrap();
    let mute = json!({"discoveryId": ID, "action": "mute-network"});
    discovery_respond(&c, mute).await.unwrap();
    let doc: Value = serde_json::from_str(&read(&dir)).unwrap();
    assert_eq!(doc["silenced"][ID], json!("forever"));
    assert_eq!(doc["networks"][NET]["muted"], json!(true));
    assert_eq!(doc["rev"], json!(7));
    assert_eq!(doc["networksRev"], json!(3));
    let missing = json!({"discoveryId": "a".repeat(26), "action": "later"});
    assert_eq!(
        error(discovery_respond(&c, missing)).await,
        (
            Code::NotFound,
            "That machine is no longer in the list.".into()
        )
    );
}

#[tokio::test]
async fn params_match_zod_issue_text() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let cases = [
        (
            "discovery.set",
            json!({}),
            "enabled: Invalid input: expected boolean, received undefined",
        ),
        (
            "discovery.set",
            json!({"enabled": 1, "expect_rev": -1.5}),
            "enabled: Invalid input: expected boolean, received number; expect_rev: Invalid input: expected int, received number",
        ),
        (
            "discovery.set",
            json!({"enabled": true, "expect_rev": 1e300, "x": 1}),
            "expect_rev: Too big: expected int to be <=9007199254740991; expect_rev: Too big: expected int to be <=9007199254740991",
        ),
        (
            "discovery.set",
            json!({"enabled": true, "expect_rev": -9007199254740992.0}),
            "expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >=0; expect_rev: Too small: expected int to be >=-9007199254740991",
        ),
        (
            "discovery.set",
            json!({"enabled": true, "expect_rev": null}),
            "expect_rev: Invalid input: expected number, received null",
        ),
        (
            "discovery.respond",
            json!({"discoveryId": "A", "action": 5}),
            "discoveryId: Invalid string: must match pattern /^[a-z2-7]{26}$/; action: Invalid option: expected one of \"pair\"|\"later\"|\"ignore\"|\"mute-network\"",
        ),
        (
            "discovery.respond",
            json!("x"),
            "params: Invalid input: expected object, received string",
        ),
    ];
    for (op, params, message) in cases {
        let future = if op == "discovery.set" {
            discovery_set(&c, params)
        } else {
            discovery_respond(&c, params)
        };
        assert_eq!(error(future).await, (Code::InvalidInput, message.into()));
    }
    assert!(!dir.path().join("discovery").exists());
}

#[test]
fn forwards_pair_and_states_typescript_must_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let set = json!({"enabled": true});
    let mute = json!({"discoveryId": ID, "action": "mute-network"});
    assert!(!discovery_stays_forwarded(&c, "discovery.set", &set));
    assert!(discovery_stays_forwarded(
        &c,
        "discovery.respond",
        &json!({"action": "pair"})
    ));
    assert!(!discovery_stays_forwarded(&c, "discovery.list", &set));
    write(&dir, &serde_json::to_string(&found()).unwrap());
    assert!(!discovery_stays_forwarded(&c, "discovery.respond", &mute));
    for text in [
        "{\"rev\":1.5}",
        "{\"rev\":\"1\"}",
        "{\"networks\":[]}",
        "{\"extra\":{\"0\":1}}",
        "{\"__proto__\":{}}",
        "{\"rev\":9007199254740993}",
        "{\"x\":\"\\ud800\"}",
        "{",
    ] {
        write(&dir, text);
        assert!(
            discovery_stays_forwarded(&c, "discovery.set", &set),
            "{text}"
        );
    }
    for network in [json!("toString"), json!(5), json!(null)] {
        let mut state = found();
        state["seen"][ID]["network"] = network.clone();
        write(&dir, &state.to_string());
        assert!(
            discovery_stays_forwarded(&c, "discovery.respond", &mute),
            "{network}"
        );
    }
    let mut state = found();
    state["networks"][NET] = json!(1);
    write(&dir, &state.to_string());
    assert!(discovery_stays_forwarded(&c, "discovery.respond", &mute));
    state["networks"][NET] = json!(0);
    write(&dir, &state.to_string());
    assert!(!discovery_stays_forwarded(&c, "discovery.respond", &mute));
    state["seen"][ID] = json!(1);
    write(&dir, &state.to_string());
    let later = json!({"discoveryId": ID, "action": "later"});
    assert!(discovery_stays_forwarded(&c, "discovery.respond", &later));
}
