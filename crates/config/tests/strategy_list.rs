#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use serde_json::Value;
use std::{collections::HashMap, fs};

fn goldens() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-list/goldens.json"
    ))
    .unwrap()
}

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(
        dir.path().join("home"),
        dir.path().join("pacer"),
        HashMap::new(),
        12345.0,
    )
}

fn seed(ctx: &Ctx, case: &Value) {
    fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
    fs::write(
        ctx.pacer_home.join("strategy.yaml"),
        case["defaultYaml"].as_str().unwrap(),
    )
    .unwrap();
    if let Some(named) = case["named"].as_object() {
        for (name, yaml) in named {
            fs::write(
                ctx.pacer_home
                    .join("strategies")
                    .join(format!("{name}.yaml")),
                yaml.as_str().unwrap(),
            )
            .unwrap();
        }
    }
    if let Some(active) = case["active"].as_str() {
        fs::write(ctx.pacer_home.join("active"), format!("{active}\n")).unwrap();
    }
}

#[test]
fn supported_list_shapes_match_typescript_goldens_without_writes() {
    for case in goldens() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        seed(&ctx, &case);
        if case["id"] == "invalid-named" {
            assert!(pacer_config::requires_core_strategy_list_parser(&ctx));
            continue;
        }
        let before = fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap();
        assert!(!pacer_config::requires_core_strategy_list_parser(&ctx));
        assert_eq!(
            pacer_config::strategy_list(&ctx).unwrap(),
            case["result"],
            "{}",
            case["id"]
        );
        assert_eq!(
            fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap(),
            before
        );
    }
}

#[test]
fn unsupported_named_strategy_and_active_switch_forward_the_whole_call() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let case = goldens()
        .into_iter()
        .find(|case| case["id"] == "default-only")
        .unwrap();
    seed(&ctx, &case);
    assert!(!pacer_config::requires_core_strategy_list_parser(&ctx));
    fs::write(ctx.pacer_home.join("active"), "missing\n").unwrap();
    assert!(pacer_config::requires_core_strategy_list_parser(&ctx));
    fs::remove_file(ctx.pacer_home.join("active")).unwrap();
    fs::write(
        ctx.pacer_home.join("strategies").join("bad!.yaml"),
        case["defaultYaml"].as_str().unwrap(),
    )
    .unwrap();
    assert!(pacer_config::requires_core_strategy_list_parser(&ctx));
}

#[cfg(unix)]
#[test]
fn symlinked_strategy_components_forward_without_reading_the_target() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let case = goldens()
        .into_iter()
        .find(|case| case["id"] == "default-only")
        .unwrap();
    seed(&ctx, &case);
    let private = dir.path().join("private.yaml");
    fs::write(&private, case["defaultYaml"].as_str().unwrap()).unwrap();
    fs::remove_file(ctx.pacer_home.join("strategy.yaml")).unwrap();
    symlink(&private, ctx.pacer_home.join("strategy.yaml")).unwrap();
    assert!(pacer_config::requires_core_strategy_list_parser(&ctx));
    assert_eq!(
        fs::read(&private).unwrap(),
        case["defaultYaml"].as_str().unwrap().as_bytes()
    );
    fs::remove_file(ctx.pacer_home.join("strategy.yaml")).unwrap();
    fs::write(
        ctx.pacer_home.join("strategy.yaml"),
        case["defaultYaml"].as_str().unwrap(),
    )
    .unwrap();
    fs::remove_dir(ctx.pacer_home.join("strategies")).unwrap();
    let outside = dir.path().join("other-strategies");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, ctx.pacer_home.join("strategies")).unwrap();
    assert!(pacer_config::requires_core_strategy_list_parser(&ctx));
}
