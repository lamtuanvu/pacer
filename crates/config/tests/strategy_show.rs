#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn cases() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-list/show-goldens.json"
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
fn supported_show_shapes_match_typescript_goldens_without_writes() {
    for case in cases() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        seed(&ctx, &case);
        let params = json!({"name":case["name"]});
        if case["result"].is_null() || case["id"] == "invalid-named" {
            assert!(pacer_config::requires_core_strategy_show_parser(
                &ctx, &params
            ));
            continue;
        }
        let before = fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap();
        assert!(!pacer_config::requires_core_strategy_show_parser(
            &ctx, &params
        ));
        assert_eq!(
            pacer_config::strategy_show(&ctx, &params).unwrap(),
            case["result"],
            "{} / {}",
            case["id"],
            case["name"]
        );
        assert_eq!(
            fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap(),
            before
        );
    }
}

#[test]
fn unsupported_params_and_changed_file_forward() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let case = cases().into_iter().next().unwrap();
    seed(&ctx, &case);
    for params in [
        Value::Null,
        json!({}),
        json!({"name":7}),
        json!({"name":"missing"}),
    ] {
        assert!(pacer_config::requires_core_strategy_show_parser(
            &ctx, &params
        ));
    }
    let params = json!({"name":"default"});
    assert!(!pacer_config::requires_core_strategy_show_parser(
        &ctx, &params
    ));
    fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: [bad]\n").unwrap();
    assert!(pacer_config::requires_core_strategy_show_parser(
        &ctx, &params
    ));
}
