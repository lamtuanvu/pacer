#![allow(clippy::unwrap_used)]
//! Native parity tests for the app error pages, hop page and code store.
use super::*;
use axum::{body::to_bytes, http::Method};
use sha2::{Digest, Sha256};

async fn body(response: Response) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn fixture() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().join("pacer"),
        Default::default(),
        1_800_000_000.0,
    );
    (dir, ctx)
}

#[test]
fn page_and_script_hashes_equal_the_typescript_constants() {
    // test/app-auth.test.ts:339 pins the stylesheet's base64 sha256; the hop script
    // hash is src/serve/app-routes.ts:29.
    assert_eq!(
        app_pages::style_hash(),
        "ZDD3cshWQtjeoVoSEoU5v8FMzhufZIqBKOe5dGqD0UM="
    );
    assert_eq!(
        app_pages::script_hash(),
        "3ukV13AcXycDdfrSmVqp+gHd3LbC9eo9btmZsn4/XQM="
    );
    let csp = app_pages::app_page("Not found.", StatusCode::NOT_FOUND)
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(csp.contains("style-src 'self' 'sha256-ZDD3cshWQtjeoVoSEoU5v8FMzhufZIqBKOe5dGqD0UM='"));
    assert!(csp.contains("script-src 'self'"));
    assert!(!csp.contains("unsafe-inline"));
}

#[tokio::test]
async fn app_page_bytes_equal_the_typescript_renderings() {
    for (message, status, expected, ended) in [
        (
            "Session ended. Run `pacer open`.",
            StatusCode::UNAUTHORIZED,
            "fc719f81c7349cf45081af92251569c5041483b5b86e421e4686b3c0506ec6b5",
            true,
        ),
        (
            "This link has expired. Run `pacer open` again.",
            StatusCode::FORBIDDEN,
            "f2694b511f597f4a610ddc5c1b85ffccca9ae8234133033fd13c2197f717049f",
            true,
        ),
        (
            "Forbidden.",
            StatusCode::FORBIDDEN,
            "4eaf0231de5428d452150c5a9a32ee17352ee95b0abe00a44a9219f7fe082a11",
            false,
        ),
        (
            "Not found.",
            StatusCode::NOT_FOUND,
            "834796c6b4e8fc86d21a45446d655ca0f6f025c86edb08495d441ba9e96b1775",
            false,
        ),
        (
            "Method not allowed.",
            StatusCode::METHOD_NOT_ALLOWED,
            "26409fa0c5e52991b0d0e5dd3eb029a9575eb37620951b43d198e832e67d9b5b",
            false,
        ),
    ] {
        let response = app_pages::app_page(message, status);
        assert_eq!(response.status(), status);
        let bytes = body(response).await;
        assert_eq!(hash(&bytes), expected, "{message} {status}");
        let html = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(
            html.contains("data-pacer-session-ended=\"true\""),
            ended,
            "{message} {status}"
        );
        assert!(!html.to_ascii_lowercase().contains("<script"));
        assert!(html.contains("font: var(--type-body-size)/var(--type-body-line) var(--font-sans)"));
        assert!(html.contains("prefers-color-scheme: dark"));
        assert!(html.contains("<a class=\"button\""));
        assert!(html.contains("readonly value=\"pacer open\""));
    }
}

#[tokio::test]
async fn app_page_escapes_html_like_typescript() {
    let response = app_pages::app_page("<script>alert(\"test\")</script>", StatusCode::BAD_REQUEST);
    let bytes = body(response).await;
    assert_eq!(
        hash(&bytes),
        "18ac087d76e0b219fa44ed7f235338977555569d2ec8c392b13dccaaa7e8ddfc"
    );
    let html = std::str::from_utf8(&bytes).unwrap();
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.contains("<script>"));
}

#[tokio::test]
async fn hop_page_sets_the_cookie_and_script_csp() {
    let response = app_pages::hop_page("0123456789abcdef0123456789abcdef");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("set-cookie").unwrap(),
        "pacer_session=0123456789abcdef0123456789abcdef; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
    );
    assert_eq!(
        response.headers().get("cache-control").unwrap(),
        "no-store"
    );
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/html; charset=utf-8"
    );
    let csp = response
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(csp.contains("script-src 'sha256-3ukV13AcXycDdfrSmVqp+gHd3LbC9eo9btmZsn4/XQM='"));
    assert_eq!(
        String::from_utf8(body(response).await).unwrap(),
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>pacer</title><noscript><meta http-equiv=\"refresh\" content=\"0;url=/app/\"></noscript></head><body><script>location.replace(\"/app/\" + location.hash);</script></body></html>"
    );
}

#[test]
fn a_typescript_written_code_is_redeemed_once_and_expires() {
    let (_dir, mut ctx) = fixture();
    let code = "a".repeat(64);
    let digest = hex::encode(Sha256::digest(code.as_bytes()));
    let store = ctx.pacer_home.join("app");
    std::fs::create_dir_all(&store).unwrap();
    // The exact bytes TypeScript's createCode writes.
    std::fs::write(
        store.join("codes.json"),
        format!("[{{\"hash\":\"{digest}\",\"expiresAt\":{}}}]\n", ctx.now + 60.0),
    )
    .unwrap();
    assert!(app_codes::redeem(&ctx, &code).unwrap());
    assert_eq!(
        std::fs::read_to_string(store.join("codes.json")).unwrap(),
        "[]\n"
    );
    assert!(!app_codes::redeem(&ctx, &code).unwrap());
    assert!(!app_codes::redeem(&ctx, "wrong").unwrap());

    // A record whose expiry has passed is ignored, just as app-auth.ts:20 filters it.
    std::fs::write(
        store.join("codes.json"),
        format!("[{{\"hash\":\"{digest}\",\"expiresAt\":{}}}]\n", ctx.now + 1.0),
    )
    .unwrap();
    ctx.now += 2.0;
    assert!(!app_codes::redeem(&ctx, &code).unwrap());

    use std::os::unix::fs::MetadataExt;
    assert_eq!(
        std::fs::metadata(store.join("codes.json"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(std::fs::metadata(&store).unwrap().mode() & 0o777, 0o700);
}

#[test]
fn native_code_creation_is_compatible_with_the_typescript_store() {
    let (_dir, ctx) = fixture();
    let code = app_codes::create(&ctx).unwrap();
    assert_eq!(code.len(), 64);
    let records: Value =
        serde_json::from_str(&std::fs::read_to_string(ctx.pacer_home.join("app/codes.json")).unwrap())
            .unwrap();
    let record = &records[0];
    assert_eq!(record["hash"], hex::encode(Sha256::digest(code.as_bytes())));
    assert_eq!(record["expiresAt"].as_f64().unwrap(), ctx.now + 60.0);
    assert!(app_codes::redeem(&ctx, &code).unwrap());
    assert!(!app_codes::redeem(&ctx, &code).unwrap());
}

#[test]
fn malformed_and_unrelated_records_do_not_create_a_code() {
    let (_dir, ctx) = fixture();
    let path = ctx.pacer_home.join("app/codes.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    for data in [
        "{",
        "{}",
        "[null,{}, {\"hash\":\"bad\",\"expiresAt\":9999999999}]",
        "[{\"hash\":\"ABC\",\"expiresAt\":9999999999}]",
    ] {
        std::fs::write(&path, data).unwrap();
        assert!(!app_codes::redeem(&ctx, "anything").unwrap(), "{data}");
    }
}

#[tokio::test]
async fn asset_misses_and_unsupported_methods_are_native_pages() {
    for (method, path, status, message) in [
        (Method::GET, "/app/missing.js", 404, "Not found."),
        (Method::GET, "/app/missing.js/", 404, "Not found."),
        (Method::POST, "/app/app.js", 405, "Method not allowed."),
    ] {
        let request = Request::builder()
            .method(method.clone())
            .uri(path)
            .body(())
            .unwrap();
        let response = app_assets::route(&request).unwrap_or_else(|| panic!("{method} {path}"));
        assert_eq!(response.status().as_u16(), status, "{method} {path}");
        let bytes = body(response).await;
        let expected = body(app_pages::app_page(message, StatusCode::from_u16(status).unwrap())).await;
        assert_eq!(bytes, expected, "{method} {path}");
    }
    // The sign-in route stays in serve::handle so it can redeem a code.
    let request = Request::builder().uri("/app/auth").body(()).unwrap();
    assert!(app_assets::route(&request).is_none());
    // Non-app paths are untouched.
    let request = Request::builder().uri("/v3/attachments").body(()).unwrap();
    assert!(app_assets::route(&request).is_none());
}
