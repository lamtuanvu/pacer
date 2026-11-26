#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

struct Models(Value);
impl EndpointModels for Models {
    fn models(&mut self, _: &str, _: u32) -> OpFuture<'_> {
        let reply = self.0.clone();
        Box::pin(async move { Ok(reply) })
    }
}

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
        json!({"connected": false, "command": "opencode auth login --standalone acme"})
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
async fn models_rank_fresh_catalog_entries() {
    let (_dir, ctx) = home(1000.0);
    cache(
        &ctx,
        900.0,
        json!([
            model("big", json!(200_000), json!("2025-01-01"), json!(1)),
            model("small", json!(null), json!(null), json!(null)),
            model("my-coder", json!(8_000), json!(null), json!(2)),
        ]),
    );
    let out = executor_setup_models(
        &ctx,
        json!({"provider": "acme", "group": "catalog"}),
        &mut Models(json!({"listed":false,"models":[]})),
    )
    .await
    .unwrap();
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
}

#[tokio::test]
async fn local_and_base_url_probe_endpoint_models() {
    let (_dir, mut ctx) = home(1000.0);
    cache(
        &ctx,
        900.0,
        json!([model("big", json!(200_000), json!(null), json!(1))]),
    );
    let mut reply =
        Models(json!({"listed":true,"models":[{"id":"embed-x"},{"id":"fixture-coder"}]}));
    let out = executor_setup_models(
        &ctx,
        json!({"provider":"acme","group":"local","base_url":"http://127.0.0.1:1/v1"}),
        &mut reply,
    )
    .await
    .unwrap();
    assert_eq!(out["filtered"], "ids");
    assert_eq!(out["pick"]["id"], "fixture-coder");
    assert_eq!(out["usage"], json!({"usage":"unmetered","known":true}));
    ctx.env
        .insert("PACER_ENFORCEMENT_TOKEN".into(), "pet_x".into());
    assert_eq!(
        executor_setup_models(
            &ctx,
            json!({"provider":"acme","group":"catalog"}),
            &mut reply,
        )
        .await
        .err()
        .unwrap()
        .message,
        "Enforcement identity only reports a native child denial"
    );
}

#[tokio::test]
async fn stale_catalog_refreshes_through_the_url_override() {
    let (_dir, mut ctx) = home(1000.0);
    // A stale cache with one model; the fixture catalog supplies a coder.
    cache(
        &ctx,
        1000.0 - CATALOG_MAX_AGE_S - 1.0,
        json!([model("stale", json!(1), json!(null), json!(null))]),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    ctx.env.insert(
        "PACER_CATALOG_URL".into(),
        format!("http://127.0.0.1:{port}/api.json"),
    );
    let body = json!({"acme":{"id":"acme","name":"Acme","models":{
        "fresh-coder":{"id":"fresh-coder","name":"Fresh","tool_call":true,
          "modalities":{"input":["text"],"output":["text"]},
          "limit":{"context":32000},"cost":{},"release_date":"2025-01-01"}
    }}})
    .to_string();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = [0u8; 2048];
        let _ = socket.read(&mut buf).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    let out = executor_setup_models(
        &ctx,
        json!({"provider":"acme","group":"catalog"}),
        &mut Models(json!({"listed":false,"models":[]})),
    )
    .await
    .unwrap();
    assert_eq!(out["pick"]["id"], "fresh-coder");
    let refreshed = pacer_models::catalog_fetch::read_cache(&ctx.pacer_home).unwrap();
    assert_eq!(refreshed["fetchedAt"].as_f64(), Some(1000.0));
}
