#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

fn home(now: f64) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        now,
    );
    (dir, ctx)
}

fn model(id: &str, context: Value, release: Value, cost: Value) -> Value {
    json!({"id":id,"name":id.to_uppercase(),"toolCall":true,"input":["text"],"output":["text"],"context":context,"outputLimit":null,"costIn":cost,"costOut":null,"release":release})
}

fn cache(ctx: &Ctx, fetched: f64, models: Value) {
    fs::create_dir_all(ctx.pacer_home.join("cache")).unwrap();
    fs::write(
        ctx.pacer_home.join("cache/models.json"),
        json!({"fetchedAt":fetched,"providers":{"acme":{"id":"acme","name":"Acme","env":[],"api":null,"models":models}}}).to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn connect_names_the_sign_in_command_after_zod_checks() {
    let (_dir, ctx) = home(1.0);
    assert_eq!(
        executor_setup_connect(&ctx, json!({"provider": "acme"}))
            .await
            .unwrap(),
        json!({"connected": false, "command": "opencode auth login acme"})
    );
    assert_eq!(
        executor_setup_connect(&ctx, json!({"provider": "-x", "key": ""}))
            .await
            .err()
            .unwrap()
            .message,
        "provider: Invalid string: must match pattern /^[a-z0-9][a-z0-9._-]*$/; key: Too small: expected string to have >=1 characters"
    );
}

#[tokio::test]
async fn models_rank_fresh_catalog_entries_and_forward_otherwise() {
    let (_dir, ctx) = home(1000.0);
    let params = json!({"provider": "acme", "group": "catalog"});
    assert!(executor_setup_models_stays_forwarded(&ctx, &params));
    cache(
        &ctx,
        900.0,
        json!([
            model("big", json!(200_000), json!("2025-01-01"), json!(1)),
            model("small", json!(null), json!(null), json!(null)),
            model("my-coder", json!(8_000), json!(null), json!(2)),
        ]),
    );
    assert!(!executor_setup_models_stays_forwarded(&ctx, &params));
    assert!(executor_setup_models_stays_forwarded(
        &ctx,
        &json!({"provider": "acme", "group": "local"})
    ));
    let out = executor_setup_models(&ctx, params.clone()).await.unwrap();
    assert_eq!(out["pick"]["id"], "my-coder");
    let rest: Vec<_> = out["rest"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    assert_eq!(rest, [json!("big"), json!("small")]);
    assert_eq!(out["rest"][1]["context"], 128_000);
    assert_eq!(out["usage"], json!({"usage":"metered","known":true}));
    assert_eq!(
        models_params(&json!({"provider": ""}))
            .err()
            .unwrap()
            .message,
        "provider: Too small: expected string to have >=1 characters; group: Invalid option: expected one of \"signed_in\"|\"local\"|\"catalog\""
    );
    cache(
        &ctx,
        1000.0 - CATALOG_MAX_AGE_S,
        json!([model("a", json!(1), json!(null), json!(null))]),
    );
    assert!(executor_setup_models_stays_forwarded(&ctx, &params));
}
