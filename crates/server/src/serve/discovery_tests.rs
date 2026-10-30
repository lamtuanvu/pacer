#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::discovery::{AdvertAction, advert_action, observation_from, validate_config};
use pacer_mdns::Interface;
use serde_json::json;
use std::{collections::HashMap, net::Ipv4Addr};

fn advert(txt: serde_json::Value) -> serde_json::Value {
    json!({"rev": 1, "enabled": true, "listen": true, "iface": "en0", "ifaceAddr": "192.168.1.10", "ifaceMask": "255.255.255.0", "advertise": {"instance": "a".repeat(26), "port": 9, "txt": txt}})
}

#[test]
fn config_carries_the_interface_and_no_interface_means_no_radio() {
    let cfg = validate_config(&advert(
        json!({"id": "a".repeat(26), "name": "n", "v": "1"}),
    ))
    .unwrap();
    assert_eq!(
        cfg.iface,
        Some(Interface {
            name: "en0".into(),
            addr: Ipv4Addr::new(192, 168, 1, 10),
            mask: Ipv4Addr::new(255, 255, 255, 0),
        })
    );
    assert!(cfg.listen && cfg.advertise.is_some());
    for iface in [
        json!(null),
        json!(""),
        json!("en0; rm"),
        json!("x".repeat(33)),
        json!(7),
    ] {
        let mut raw = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1"}));
        raw["iface"] = iface;
        let cfg = validate_config(&raw).unwrap();
        assert_eq!(cfg.iface, None);
        assert!(!cfg.listen);
        assert!(cfg.advertise.is_none());
    }
    let mut raw = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1"}));
    raw.as_object_mut().unwrap().remove("iface");
    assert!(!validate_config(&raw).unwrap().listen);
}

#[test]
fn without_a_usable_ipv4_address_and_netmask_there_is_no_radio() {
    let cases = [
        ("ifaceAddr", json!(null)),
        ("ifaceAddr", json!("fe80::1")),
        ("ifaceAddr", json!("192.168.1")),
        ("ifaceAddr", json!("127.0.0.1")),
        ("ifaceAddr", json!("0.0.0.0")),
        ("ifaceAddr", json!("224.0.0.251")),
        ("ifaceMask", json!(null)),
        ("ifaceMask", json!("255.0.255.0")),
        ("ifaceMask", json!("0.0.0.0")),
        ("ifaceMask", json!("255.255.255.255")),
    ];
    for (key, value) in cases {
        let mut raw = advert(json!({"id": "a".repeat(26), "name": "n", "v": "1"}));
        raw[key] = value.clone();
        let cfg = validate_config(&raw).unwrap();
        assert_eq!(cfg.iface, None, "{key} {value}");
        assert!(!cfg.listen && cfg.advertise.is_none(), "{key} {value}");
    }
}

#[test]
fn config_with_bounded_txt_is_accepted() {
    let raw = json!({"rev": 3, "enabled": true, "listen": true, "iface": "en0", "ifaceAddr": "10.0.0.2", "ifaceMask": "255.255.0.0", "advertise": {"instance": "a".repeat(26), "port": 9, "txt": {"id": "a".repeat(26), "name": "pacer-k3x9", "v": "3.1.0"}}});
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
    let null =
        json!({"rev": 1, "enabled": true, "listen": false, "iface": "en0", "advertise": null});
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

fn config(rev: u64, txt: serde_json::Value) -> super::discovery::Config {
    let mut raw = advert(txt);
    raw["rev"] = json!(rev);
    validate_config(&raw).unwrap()
}

#[test]
fn a_new_rev_with_the_same_advert_keeps_the_registration() {
    let txt = json!({"id": "a".repeat(26), "name": "n", "v": "1"});
    let previous = config(1, txt.clone());
    let next = config(2, txt);
    assert_eq!(
        advert_action(Some(&previous), true, &next),
        AdvertAction::Keep
    );
    let mut quiet = next.clone();
    quiet.listen = false;
    assert_eq!(
        advert_action(Some(&previous), true, &quiet),
        AdvertAction::Keep
    );
}

#[test]
fn a_changed_advert_or_interface_registers_again() {
    let txt = json!({"id": "a".repeat(26), "name": "n", "v": "1"});
    let previous = config(1, txt.clone());
    let renamed = config(1, json!({"id": "a".repeat(26), "name": "m", "v": "1"}));
    assert_eq!(
        advert_action(Some(&previous), true, &renamed),
        AdvertAction::Register
    );
    let mut moved = previous.clone();
    moved.advertise.as_mut().unwrap().port = 10;
    assert_eq!(
        advert_action(Some(&previous), true, &moved),
        AdvertAction::Register
    );
    let mut wifi = previous.clone();
    wifi.iface.as_mut().unwrap().name = "en1".to_string();
    assert_eq!(
        advert_action(Some(&previous), true, &wifi),
        AdvertAction::Register
    );
    let mut readdressed = previous.clone();
    readdressed.iface.as_mut().unwrap().addr = Ipv4Addr::new(192, 168, 1, 11);
    assert_eq!(
        advert_action(Some(&previous), true, &readdressed),
        AdvertAction::Register
    );
    assert_eq!(
        advert_action(None, false, &previous),
        AdvertAction::Register
    );
    // A registration that failed is retried on the next poll.
    assert_eq!(
        advert_action(Some(&previous), false, &config(2, txt)),
        AdvertAction::Register
    );
}

#[test]
fn a_null_advert_unregisters() {
    let previous = config(1, json!({"id": "a".repeat(26), "name": "n", "v": "1"}));
    let mut next = previous.clone();
    next.rev = 2;
    next.advertise = None;
    assert_eq!(
        advert_action(Some(&previous), true, &next),
        AdvertAction::Unregister
    );
    assert_eq!(advert_action(Some(&next), false, &next), AdvertAction::Keep);
}
