#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-helpers.test.ts.
use pacer_plugin::install::{backup_path, sha256, shell_command, shq, zone};
use serde_json::Value;

const ORACLE: &str = include_str!("fixtures/install/helpers-oracle.json");

// test/plugin-sdk-install-helpers.test.ts:5 backup path time and collision suffixes
#[test]
fn backup_path_local_time_and_collision_suffixes() {
    let tz = zone("Asia/Ho_Chi_Minh").unwrap();
    let now = jiff::civil::date(2026, 10, 11)
        .at(9, 5, 0, 0)
        .to_zoned(tz.clone())
        .unwrap()
        .timestamp()
        .as_second()
        + 7;
    let path = "$HOME/config.toml";
    let occupied = std::sync::Mutex::new(std::collections::BTreeSet::new());
    let exists = |candidate: &str| occupied.lock().unwrap().contains(candidate);
    let first = backup_path(path, now, &tz, exists);
    assert_eq!(first, "$HOME/config.toml.pacer-bak-20261011-090507");
    occupied.lock().unwrap().insert(first.clone());
    assert_eq!(backup_path(path, now, &tz, exists), format!("{first}-2"));
    occupied.lock().unwrap().insert(format!("{first}-2"));
    assert_eq!(backup_path(path, now, &tz, exists), format!("{first}-3"));
}

// test/plugin-sdk-install-helpers.test.ts:13 sha256 and shell command match host
#[test]
fn sha256_and_shell_command_match_host() {
    let oracle: Value = serde_json::from_str(ORACLE).unwrap();
    assert_eq!(
        sha256("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    for (text, expected) in oracle["sha256"].as_object().unwrap() {
        assert_eq!(sha256(text), expected.as_str().unwrap(), "text {text:?}");
    }
    assert_eq!(oracle["hostAgree"], true);
    for row in oracle["shellCommand"].as_array().unwrap() {
        let argv: Vec<String> = row["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(shell_command(&argv), row["command"].as_str().unwrap());
    }
    assert_eq!(
        shell_command(&["/opt/My Disk/pacer".into(), "it's".into()]),
        "'/opt/My Disk/pacer' 'it'\\''s'"
    );
    assert_eq!(shq("/usr/bin/pacer_-.:=@%+"), "/usr/bin/pacer_-.:=@%+");
    assert_eq!(shq(""), "''");
    assert_eq!(shq("$(echo unsafe)"), "'$(echo unsafe)'");
    assert!(shell_command(&[]).is_empty());
}
