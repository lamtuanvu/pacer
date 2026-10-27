#![allow(clippy::unwrap_used)]

use axum::{body::to_bytes, http::Request};
use pacer_foundation::Ctx;
use pacer_server::serve::{
    auth::{self, AuthKind, Decision},
    sessions,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

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
fn rejection_content_types_match_the_bun_public_listener() {
    let (_dir, ctx) = fixture();
    for (host, status, content_type) in [
        ("127.0.0.1:4317", 401, Some("text/plain;charset=utf-8")),
        ("foreign.invalid", 421, None),
    ] {
        let req = Request::builder()
            .uri("/v3/hello")
            .header("host", host)
            .body(())
            .unwrap();
        let Decision::Reject(response) = auth::classify(&req, 4317, "token", &ctx) else {
            panic!("request must be rejected");
        };
        assert_eq!(response.status(), status);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .map(|v| v.to_str().unwrap()),
            content_type
        );
    }
}

#[test]
fn enforcement_identity_only_reaches_its_denial_operation() {
    let (_dir, ctx) = fixture();
    let token = auth::ensure_token(&ctx).unwrap();
    let identity = format!("pet_{}", "a".repeat(64));
    for (method, path, forwarded) in [
        ("POST", "/v3/ops/dispatch.enforcement.denied", true),
        ("POST", "/v3/ops/dispatch.child", false),
        ("GET", "/v3/ops/dispatch.enforcement.denied", false),
        ("GET", "/v3/snapshot", false),
    ] {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:4317")
            .header("authorization", format!("Bearer {identity}"))
            .body(())
            .unwrap();
        match auth::classify(&req, 4317, &token, &ctx) {
            Decision::Forward {
                auth: AuthKind::Task,
            } if forwarded => {}
            Decision::Reject(response) if !forwarded => assert_eq!(response.status().as_u16(), 403),
            _ => panic!("unexpected enforcement identity route: {method} {path}"),
        }
    }
}

#[tokio::test]
async fn committed_auth_goldens() {
    let (_dir, ctx) = fixture();
    let token = auth::ensure_token(&ctx).unwrap();
    let cookie = format!("pacer_session={}", sessions::create(&ctx).unwrap());
    let rows: Vec<Value> = serde_json::from_str(include_str!("golden/serve-auth.json")).unwrap();
    for row in rows {
        let path = row["path"].as_str().unwrap();
        let name = row["name"].as_str().unwrap();
        let mut req = Request::builder()
            .method(row["method"].as_str().unwrap())
            .uri(path);
        for (key, value) in row["headers"].as_object().unwrap() {
            req = req.header(
                key,
                value
                    .as_str()
                    .unwrap()
                    .replace("<port>", "4317")
                    .replace("<token>", &token)
                    .replace("<cookie>", &cookie),
            );
        }
        match auth::classify(&req.body(()).unwrap(), 4317, &token, &ctx) {
            Decision::Health => assert_eq!(path, "/health", "{name}"),
            Decision::AppAuth => assert_eq!(path, "/app/auth", "{name}"),
            Decision::Forward { auth } => {
                assert_eq!(row["status"], 200, "{name}");
                assert_eq!(
                    auth,
                    if name.starts_with("cookie") {
                        AuthKind::Cookie
                    } else {
                        AuthKind::Bearer
                    }
                );
            }
            Decision::Reject(response) => {
                assert_eq!(
                    response.status().as_u16() as u64,
                    row["status"].as_u64().unwrap(),
                    "{name}"
                );
                // The core supplies /app/ error HTML through /_internal/app-page in production.
                // These three classifier rows check status only; no core fetch is needed here.
                if response.extensions().get::<auth::AppPage>().is_some() {
                    assert!(path.starts_with("/app/"));
                    assert!(row["bodySha256"].is_string());
                    continue;
                }
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                if let Some(hash) = row["bodySha256"].as_str() {
                    assert_eq!(hex::encode(Sha256::digest(&body)), hash, "{name}");
                } else {
                    assert_eq!(
                        std::str::from_utf8(&body).unwrap(),
                        row["body"].as_str().unwrap(),
                        "{name}"
                    );
                }
            }
        }
    }
}

#[test]
fn sessions_slide_only_after_a_day_and_expire() {
    let (_dir, mut ctx) = fixture();
    let value = sessions::create(&ctx).unwrap();
    let path = ctx.pacer_home.join("app/sessions.json");
    let original = std::fs::read(&path).unwrap();
    ctx.now += 86400.0;
    assert!(sessions::check(&ctx, &value).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    ctx.now += 1.0;
    assert!(sessions::check(&ctx, &value).unwrap());
    assert_ne!(std::fs::read(&path).unwrap(), original);
    assert!(!sessions::check(&ctx, "wrong").unwrap());
    ctx.now += sessions::SESSION_SECONDS;
    assert!(!sessions::check(&ctx, &value).unwrap());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn token_reuse_and_safe_comparison() {
    let (_dir, ctx) = fixture();
    let token = auth::ensure_token(&ctx).unwrap();
    assert_eq!(token.len(), 48);
    assert_eq!(auth::ensure_token(&ctx).unwrap(), token);
    std::fs::write(ctx.pacer_home.join("token"), "  existing-token\n").unwrap();
    assert_eq!(auth::ensure_token(&ctx).unwrap(), "existing-token");
    assert!(auth::safe_equal("secret", "secret"));
    assert!(!auth::safe_equal("secret", "secreu"));
    assert!(!auth::safe_equal("secret", "secrets"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(ctx.pacer_home.join("token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn invalid_session_records_and_io_errors() {
    let (_dir, ctx) = fixture();
    assert!(!sessions::check(&ctx, "missing").unwrap());
    let value = sessions::create(&ctx).unwrap();
    let path = ctx.pacer_home.join("app/sessions.json");
    for data in [
        "{",
        "{}",
        "[null,{}, {\"hash\":\"bad\",\"expiresAt\":9999999999}]",
    ] {
        std::fs::write(&path, data).unwrap();
        assert!(!sessions::check(&ctx, &value).unwrap());
    }
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(sessions::check(&ctx, &value).is_err());
}

#[test]
fn ordering_and_browser_rule_edges() {
    let (_dir, ctx) = fixture();
    let token = auth::ensure_token(&ctx).unwrap();
    let value = sessions::create(&ctx).unwrap();
    let cookie = format!("other=x; pacer_session={value}; pacer_session=bad");
    let cases = [
        ("OPTIONS", "/health", "wrong", None, None, None, None, 421),
        (
            "OPTIONS",
            "/app/auth",
            "localhost:4317",
            None,
            None,
            None,
            None,
            405,
        ),
        (
            "POST",
            "/v2/ops/x",
            "localhost:4317",
            Some(cookie.as_str()),
            Some("http://localhost:4317"),
            Some("app"),
            Some("none"),
            200,
        ),
        (
            "HEAD",
            "/app/x",
            "localhost:4317",
            Some(cookie.as_str()),
            None,
            None,
            None,
            200,
        ),
        (
            "POST",
            "/app/x",
            "localhost:4317",
            Some(cookie.as_str()),
            Some("http://foreign"),
            Some("app"),
            None,
            403,
        ),
        (
            "GET",
            "/v2/tasks/task_1/session",
            "localhost:4317",
            Some(cookie.as_str()),
            None,
            None,
            None,
            403,
        ),
        (
            "GET",
            "/v2/tasks/task_1/session",
            "localhost:4317",
            Some(cookie.as_str()),
            Some("http://localhost:4317"),
            None,
            None,
            200,
        ),
        (
            "POST",
            "/v2/session/exchange",
            "localhost:4317",
            Some(cookie.as_str()),
            Some("http://localhost:4317"),
            Some("app"),
            None,
            403,
        ),
        (
            "GET",
            "/v3/hello",
            "localhost:4317",
            Some("pacer_session=bad; pacer_session=valid"),
            None,
            None,
            None,
            401,
        ),
    ];
    for (method, path, host, cookie, origin, client, site, status) in cases {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("host", host);
        for (name, value) in [
            ("cookie", cookie),
            ("origin", origin),
            ("x-pacer-client", client),
            ("sec-fetch-site", site),
        ] {
            if let Some(value) = value {
                req = req.header(name, value);
            }
        }
        let decision = auth::classify(&req.body(()).unwrap(), 4317, &token, &ctx);
        match decision {
            Decision::Reject(response) => {
                assert_eq!(response.status().as_u16(), status, "{method} {path}")
            }
            Decision::Forward {
                auth: AuthKind::Cookie,
            } => assert_eq!(status, 200),
            _ => panic!("unexpected decision for {method} {path}"),
        }
    }
    let req = Request::builder()
        .method("POST")
        .uri("/v3/session/exchange")
        .header("host", "localhost:4317")
        .header("authorization", format!("Bearer {token}"))
        .header("cookie", cookie)
        .header("sec-fetch-site", "cross-site")
        .body(())
        .unwrap();
    assert!(matches!(
        auth::classify(&req, 4317, &token, &ctx),
        Decision::Forward {
            auth: AuthKind::Bearer
        }
    ));
}

fn status_of(decision: Decision) -> u16 {
    match decision {
        Decision::Reject(response) => response.status().as_u16(),
        Decision::Forward { .. } => 200,
        Decision::Health | Decision::AppAuth => 0,
    }
}

#[test]
fn unnormalized_paths_are_refused_before_any_route_check() {
    let (_dir, ctx) = fixture();
    let token = auth::ensure_token(&ctx).unwrap();
    let cookie = format!("pacer_session={}", sessions::create(&ctx).unwrap());
    let request = |path: &str, auth: (&str, &str)| {
        Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1:4317")
            .header(auth.0, auth.1)
            .body(())
            .unwrap()
    };
    let bearer = format!("Bearer {token}");
    for path in [
        "/v3/x/../session/exchange",
        "/v3/./session/exchange",
        "/v3/%2e%2e/v3/session/exchange",
        "/v3/%2E/hello",
        "/v3/tasks%2fx/session",
        "/v3//hello",
        "/v3/x\\..\\hello",
    ] {
        for auth in [
            ("cookie", cookie.as_str()),
            ("authorization", bearer.as_str()),
        ] {
            assert_eq!(
                status_of(auth::classify(&request(path, auth), 4317, &token, &ctx)),
                400,
                "{path} {}",
                auth.0
            );
        }
    }
    // A trailing slash stays a normal path.
    assert_eq!(
        status_of(auth::classify(
            &request("/app/", ("authorization", bearer.as_str())),
            4317,
            &token,
            &ctx
        )),
        200
    );
}

#[test]
fn internal_routes_are_not_public() {
    let (_dir, ctx) = fixture();
    let token = auth::ensure_token(&ctx).unwrap();
    let req = Request::builder()
        .uri("/_internal/app-page?status=1")
        .header("host", "127.0.0.1:4317")
        .header("authorization", format!("Bearer {token}"))
        .body(())
        .unwrap();
    assert_eq!(status_of(auth::classify(&req, 4317, &token, &ctx)), 404);
}

#[test]
fn sessions_expire_against_the_request_time() {
    let (_dir, ctx) = fixture();
    // A listener that started before the session expired: its start-up clock still accepts it.
    let started = Ctx {
        now: pacer_foundation::ctx::unix_now() - sessions::SESSION_SECONDS - 60.0,
        ..ctx
    };
    let value = sessions::create(&started).unwrap();
    assert!(sessions::check(&started, &value).unwrap());
    // Requests use the current clock (serve::mod handles each request with `ctx.at_now()`).
    assert!(!sessions::check(&started.at_now(), &value).unwrap());
}
