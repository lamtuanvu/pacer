#![allow(clippy::unwrap_used)]
use super::*;
use crate::network::{TEST_PROBE, set_probe_outputs_for_tests};
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

fn write(dir: &tempfile::TempDir, value: &Value) {
    fs::create_dir_all(dir.path().join("discovery")).unwrap();
    fs::write(
        dir.path().join("discovery/state.json"),
        serde_json::to_string(value).unwrap(),
    )
    .unwrap();
}

fn net(key: &str, group: Option<&str>, continues: &[&str]) -> NetworkInfo {
    NetworkInfo {
        key: key.into(),
        label: "Home".into(),
        iface: "en0".into(),
        group: group.map(str::to_owned),
        kind: "ra",
        gw: "10.0.0.1".into(),
        continues: continues.iter().map(|k| (*k).to_owned()).collect(),
    }
}

#[test]
fn find_network_follows_own_alias_and_recent_group_entries() {
    let networks = json!({
        "own": {"group": "g"},
        "aliased": {"aliases": ["old"]},
        "grouped": {"group": "h", "aliases": ["seen"]},
    });
    let networks = networks.as_object().unwrap();
    assert_eq!(
        find_network(networks, &net("own", Some("g"), &[])),
        Some(("own".into(), false))
    );
    assert_eq!(
        find_network(networks, &net("own", Some("x"), &[])),
        Some(("own".into(), true))
    );
    assert_eq!(
        find_network(networks, &net("old", None, &[])),
        Some(("aliased".into(), false))
    );
    assert_eq!(
        find_network(networks, &net("new", Some("h"), &["seen"])),
        Some(("grouped".into(), true))
    );
    assert_eq!(find_network(networks, &net("new", Some("h"), &[])), None);
    assert_eq!(network_key(networks, &net("new", None, &[])), "new");
}

#[test]
fn shapes_typescript_would_trip_over_stay_forwarded() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let forwarded =
        |c: &Ctx| crate::discovery_ops::discovery_stays_forwarded(c, "discovery.list", &json!({}));
    assert!(!forwarded(&c));
    for bad in [
        json!({"networks": {NET: null}}),
        json!({"networks": {NET: {"aliases": "x"}}}),
        json!({"seen": {ID: {"discoveryId": ID}}}),
        json!({"seen": {ID: {"lastSeen": 1}}}),
    ] {
        write(&dir, &bad);
        assert!(forwarded(&c), "{bad}");
    }
}

#[tokio::test]
async fn list_and_network_set_render_like_typescript_without_a_network() {
    let _guard = TEST_PROBE.lock().await;
    set_probe_outputs_for_tests(Some(Default::default()));
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    write(
        &dir,
        &json!({
            "rev": 3, "networksRev": 1, "enabled": true,
            "networks": {NET: {"label": "Home", "advertise": null, "discoveryId": ID, "muted": false}},
            "silenced": {ID: "forever"},
            "seen": {
                "bbbbbbbbbbbbbbbbbbbbbbbbbb": {"discoveryId": "bbbbbbbbbbbbbbbbbbbbbbbbbb", "lastSeen": 2},
                ID: {"discoveryId": ID, "name": "peer", "version": "1", "lastSeen": 9},
            },
            "prompts": [],
        }),
    );
    let list = discovery_list(&c, Value::Null, || unreachable!("no network"))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_string(&list).unwrap(),
        format!(
            r#"{{"available":false,"enabled":true,"network":null,"found":[{{"discoveryId":"{ID}","name":"peer","version":"1","lastSeen":9,"silenced":true}},{{"discoveryId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","lastSeen":2,"silenced":false}}],"rev":3,"networksRev":1}}"#
        )
    );
    let missing = discovery_network_set(&c, json!({"network": "f".repeat(32), "expect_rev": 1}))
        .await
        .unwrap_err();
    assert_eq!(
        (missing.code, missing.message.as_str()),
        (Code::NotFound, "Unknown network.")
    );
    let params = discovery_network_set(&c, json!({"network": "x", "muted": 1}))
        .await
        .unwrap_err();
    assert_eq!(
        params.message,
        "network: Invalid string: must match pattern /^[0-9a-f]{32}$/; muted: Invalid input: expected boolean, received number; expect_rev: Invalid input: expected number, received undefined"
    );
    let out = discovery_network_set(
        &c,
        json!({"network": NET, "muted": true, "resetId": true, "expect_rev": 1}),
    )
    .await
    .unwrap();
    assert_eq!(out["networksRev"], 2);
    assert_eq!(out["current"], Value::Null);
    assert_eq!(
        out["networks"],
        json!([{"key": NET, "label": "Home", "advertise": null, "muted": true}])
    );
    let text = fs::read_to_string(dir.path().join("discovery/state.json")).unwrap();
    let state: Value = serde_json::from_str(&text).unwrap();
    let id = state["networks"][NET]["discoveryId"].as_str().unwrap();
    assert!(
        id != ID
            && id.len() == 26
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
    );
    write(&dir, &json!([]));
    let corrupt = discovery_list(&c, json!({}), || unreachable!())
        .await
        .unwrap();
    assert_eq!(corrupt["enabled"], false);
    assert_eq!(corrupt["warning"], WARNING);
    set_probe_outputs_for_tests(None);
}
