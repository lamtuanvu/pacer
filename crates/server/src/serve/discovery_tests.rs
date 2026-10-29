#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::discovery::{observation_from, validate_config};
use serde_json::json;
use std::collections::HashMap;

fn advert(txt: serde_json::Value) -> serde_json::Value {
    json!({"rev": 1, "enabled": true, "listen": true, "advertise": {"instance": "a".repeat(26), "port": 9, "txt": txt}})
}

#[test]
fn config_with_bounded_txt_is_accepted() {
    let raw = json!({"rev": 3, "enabled": true, "listen": true, "advertise": {"instance": "a".repeat(26), "port": 9, "txt": {"id": "a".repeat(26), "name": "pacer-k3x9", "v": "3.1.0"}}});
    let cfg = validate_config(&raw).expect("valid");
    assert_eq!(cfg.rev, 3);
    assert!(cfg.listen);
    let advert = cfg.advertise.expect("advert");
    assert_eq!(advert.port, 9);
    assert_eq!(advert.txt["name"], "pacer-k3x9");
}

#[test]
fn oversized_or_unknown_txt_is_refused() {
    let long = advert(json!({"id": "a".repeat(26), "name": "x".repeat(65), "v": "1"}));
    assert!(validate_config(&long).unwrap().advertise.is_none());
    let extra = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1", "user": "alex"}));
    assert!(validate_config(&extra).unwrap().advertise.is_none());
    let hints = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1", "h": "x".repeat(201)}));
    assert!(validate_config(&hints).unwrap().advertise.is_none());
    let version = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1".repeat(33)}));
    assert!(validate_config(&version).unwrap().advertise.is_none());
    let bad_id = advert(json!({"id": "A".repeat(26), "name": "n", "v": "1"}));
    assert!(validate_config(&bad_id).unwrap().advertise.is_none());
    let no_id = advert(json!({"name": "n", "v": "1"}));
    assert!(validate_config(&no_id).unwrap().advertise.is_none());
}

#[test]
fn largest_allowed_advert_fits_the_record_budget() {
    // The per-key bounds keep the four allowed keys at 338 bytes, inside the 400-byte budget.
    let max = advert(
        json!({"id": "a".repeat(26), "name": "n".repeat(64), "v": "1".repeat(32), "h": "x".repeat(200)}),
    );
    assert!(validate_config(&max).unwrap().advertise.is_some());
}

#[test]
fn disabled_config_neither_listens_nor_advertises() {
    let mut raw = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1"}));
    raw["enabled"] = json!(false);
    let cfg = validate_config(&raw).unwrap();
    assert!(!cfg.listen);
    assert!(cfg.advertise.is_none());
}

#[test]
fn malformed_config_is_rejected() {
    assert!(validate_config(&json!({"enabled": true, "listen": true})).is_none());
    assert!(validate_config(&json!({"rev": -1, "enabled": true, "listen": true})).is_none());
    assert!(validate_config(&json!({"rev": 1, "enabled": "yes", "listen": true})).is_none());
    let port = json!({"rev": 1, "enabled": true, "listen": true, "advertise": {"instance": "a".repeat(26), "port": 70000, "txt": {"id": "a".repeat(26), "name": "n"}}});
    assert!(validate_config(&port).unwrap().advertise.is_none());
    let instance = json!({"rev": 1, "enabled": true, "listen": true, "advertise": {"instance": "my laptop", "port": 9, "txt": {"id": "a".repeat(26), "name": "n"}}});
    assert!(validate_config(&instance).unwrap().advertise.is_none());
    let null = json!({"rev": 1, "enabled": true, "listen": false, "advertise": null});
    assert_eq!(validate_config(&null).unwrap().advertise, None);
}

#[test]
fn observations_keep_only_known_bounded_keys() {
    let mut p = HashMap::new();
    p.insert("id".to_string(), "b".repeat(26));
    p.insert("name".to_string(), "studio".to_string());
    p.insert("v".to_string(), "3.1.0".to_string());
    p.insert("extra".to_string(), "x".to_string());
    let o = observation_from(&p).expect("kept");
    assert_eq!(o["name"], "studio");
    assert_eq!(o["h"], "");
    assert!(o.get("extra").is_none());
    p.insert("id".to_string(), "short".to_string());
    assert!(observation_from(&p).is_none());
}

#[test]
fn observations_above_any_bound_are_dropped() {
    let base = |k: &str, v: String| {
        let mut p = HashMap::from([("id".to_string(), "c".repeat(26))]);
        p.insert(k.to_string(), v);
        p
    };
    assert!(observation_from(&base("name", "n".repeat(64))).is_some());
    assert!(observation_from(&base("name", "n".repeat(65))).is_none());
    assert!(observation_from(&base("v", "1".repeat(33))).is_none());
    assert!(observation_from(&base("h", "x".repeat(201))).is_none());
    // Unknown keys are not forwarded, but they still count towards the record budget.
    assert!(observation_from(&base("pad", "x".repeat(380))).is_none());
}
