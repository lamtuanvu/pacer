#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::symlink};

#[test]
fn strategy_edits_match_typescript_bytes() {
    let rows: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/plugin-strategy-byte-parity.json"
    ))
    .unwrap();
    for row in rows.as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap();
        let ctx = pacer_foundation::Ctx::with(path.clone(), path.clone(), Default::default(), 0.0);
        fs::write(path.join("strategy.yaml"), row["before"].as_str().unwrap()).unwrap();
        match row["op"].as_str().unwrap() {
            "enable" => edit_config(&ctx, "fx-ui", None, Some(Some(row["grant"].clone()))).unwrap(),
            "disable" => edit_config(&ctx, "fx-ui", Some(true), None).unwrap(),
            _ => {
                edit_config(&ctx, "fx-ui", Some(false), None).unwrap();
                edit_config(&ctx, "fx-ui", None, Some(None)).unwrap();
            }
        }
        assert_eq!(
            fs::read_to_string(path.join("strategy.yaml")).unwrap(),
            row["after"].as_str().unwrap(),
            "{}",
            row["name"]
        );
    }
}

#[test]
fn strategy_errors_use_configured_home() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().canonicalize().unwrap();
    let alias = real.join("alias");
    symlink(&real, &alias).unwrap();
    let ctx = pacer_foundation::Ctx::with(real.clone(), alias.clone(), Default::default(), 0.0);
    let e = edit_config(&ctx, "fx-ui", Some(true), None).unwrap_err();
    assert!(
        e.message
            .contains(&alias.join("strategy.yaml").display().to_string()),
        "{e:?}"
    );
    fs::write(real.join("strategy.yaml"), "planner: []\n").unwrap();
    let e = edit_config(&ctx, "fx-ui", Some(true), None).unwrap_err();
    assert!(
        e.message
            .contains(&alias.join("strategy.yaml").display().to_string()),
        "{e:?}"
    );
}

#[test]
fn strategy_link_replacement_preserves_target_bytes() {
    for hard in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let ctx = pacer_foundation::Ctx::with(root.clone(), root.clone(), Default::default(), 0.0);
        let before = "planner: claude-code\nproviders:\n  claude-code: {}\n";
        fs::write(root.join("target"), before).unwrap();
        if hard {
            fs::hard_link(root.join("target"), root.join("strategy.yaml")).unwrap();
        } else {
            symlink("target", root.join("strategy.yaml")).unwrap();
        }
        edit_config(&ctx, "fx-ui", Some(true), None).unwrap();
        assert_eq!(fs::read_to_string(root.join("target")).unwrap(), before);
        assert_eq!(read_config(&ctx).unwrap()["disabled"], json!(["fx-ui"]));
    }
}
