//! The non-internal startServer.fetch authentication checks, in wire order.
use axum::{
    body::Body,
    http::{HeaderValue, Request, StatusCode},
    response::Response,
};
use pacer_foundation::Ctx;
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
};
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKind {
    Bearer,
    Cookie,
    Task,
}

pub enum Decision {
    Reject(Response),
    Health,
    AppAuth,
    Forward { auth: AuthKind },
}

/// A rejected app request becomes a native error page; status and message stay
/// the marker the front door renders with `serve::app_pages::app_page`.
#[derive(Debug, Clone)]
pub struct AppPage {
    pub message: &'static str,
    pub status: StatusCode,
}

pub fn safe_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

/// ECMAScript String.prototype.trim whitespace (WhiteSpace and LineTerminator).
pub fn js_trim(value: &str) -> &str {
    super::js_trim::js_trim(value)
}

pub fn ensure_token(ctx: &Ctx) -> io::Result<String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&ctx.pacer_home)?;
    fs::set_permissions(&ctx.pacer_home, fs::Permissions::from_mode(0o700))?;
    // Keep the lock file stable: unlinking it would allow concurrent locks on
    // different inodes. The OS releases the lock if the process exits.
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(ctx.pacer_home.join(".token.lock"))?;
    lock.lock()?;
    let path = ctx.pacer_home.join("token");
    match fs::read_to_string(&path) {
        Ok(token) if !js_trim(&token).is_empty() => return Ok(js_trim(&token).to_owned()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let token = hex::encode(rand::random::<[u8; 24]>());
    let temp = ctx.pacer_home.join(format!(
        ".token.{}.tmp",
        hex::encode(rand::random::<[u8; 12]>())
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| {
        writeln!(file, "{token}")?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    let _ = fs::remove_file(&temp);
    result?;
    Ok(token)
}

fn reject(status: StatusCode, body: &'static str, app_message: Option<&'static str>) -> Decision {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    // The Bun listener's Host rejection has no Content-Type. Its other string
    // responses use Bun's exact default, rather than axum's spaced parameter.
    if status != StatusCode::MISDIRECTED_REQUEST {
        response.headers_mut().insert(
            "content-type",
            HeaderValue::from_static("text/plain;charset=utf-8"),
        );
    }
    if let Some(message) = app_message {
        response
            .extensions_mut()
            .insert(AppPage { message, status });
    }
    Decision::Reject(response)
}

/// True when no segment is empty, `.` or `..` (a trailing slash is allowed) and the path has no
/// encoded dot, slash or backslash. Clients never send other forms; Bun would rewrite them.
fn normalized(path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let lower = rest.to_ascii_lowercase();
    if lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
        || rest.contains('\\')
    {
        return false;
    }
    let segments: Vec<&str> = rest.split('/').collect();
    let last = segments.len() - 1;
    segments
        .iter()
        .enumerate()
        .all(|(i, segment)| !matches!(*segment, "." | "..") && (!segment.is_empty() || i == last))
}

pub fn classify<B>(req: &Request<B>, port: u16, token: &str, ctx: &Ctx) -> Decision {
    let header = |name: &str| super::header_value(req.headers(), name);
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !hosts
        .iter()
        .any(|host| Some(host.as_str()) == header("host").as_deref())
    {
        return reject(
            StatusCode::MISDIRECTED_REQUEST,
            "misdirected request\n",
            None,
        );
    }
    let path = req.uri().path();
    // The core routes on the normalized path, so every check here must see that same path.
    if !normalized(path) {
        return reject(StatusCode::BAD_REQUEST, "bad request\n", None);
    }
    if path.starts_with("/_internal/") {
        return reject(StatusCode::NOT_FOUND, "not found\n", None);
    }
    let app = path.starts_with("/app/");
    if req.method() == "OPTIONS" {
        return reject(
            StatusCode::METHOD_NOT_ALLOWED,
            "method not allowed\n",
            app.then_some("Method not allowed."),
        );
    }
    if req.method() == "GET" && path == "/health" {
        return Decision::Health;
    }
    if path == "/app/auth" {
        return Decision::AppAuth;
    }
    if safe_equal(
        header("authorization").as_deref().unwrap_or(""),
        &format!("Bearer {token}"),
    ) {
        return Decision::Forward {
            auth: AuthKind::Bearer,
        };
    }
    // Only the core can validate a task grant. The front door limits its transport
    // before forwarding it with the internal generation credential.
    let authorization = header("authorization");
    let bearer = authorization
        .as_deref()
        .unwrap_or("")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    if bearer.len() == 68
        && (bearer.starts_with("pwg_") || bearer.starts_with("pet_") || bearer.starts_with("pag_"))
        && bearer[4..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        // The assistant grant (`pag_`) is a third, narrower credential: one operation, `assistant.tool`.
        if req.method() == "POST"
            && (bearer.starts_with("pwg_") && path.starts_with("/v3/ops/")
                || bearer.starts_with("pet_") && path == "/v3/ops/dispatch.enforcement.denied"
                || bearer.starts_with("pag_") && path == "/v3/ops/assistant.tool")
        {
            return Decision::Forward {
                auth: AuthKind::Task,
            };
        }
        return reject(StatusCode::FORBIDDEN, "forbidden\n", None);
    }
    let api = path.starts_with("/v2/") || path.starts_with("/v3/");
    let cookie_header = header("cookie");
    let cookie = cookie_header
        .as_deref()
        .unwrap_or("")
        .split(';')
        .map(js_trim)
        .find_map(|part| part.strip_prefix("pacer_session="));
    if !(app || api)
        || !cookie.is_some_and(|value| {
            !value.is_empty() && super::sessions::check(ctx, value).unwrap_or(false)
        })
    {
        return reject(
            StatusCode::UNAUTHORIZED,
            "unauthorized\n",
            app.then_some("Session ended. Run `pacer open`."),
        );
    }
    if path == "/v2/session/exchange" || path == "/v3/session/exchange" {
        return reject(StatusCode::FORBIDDEN, "forbidden\n", None);
    }
    // Every task-owned session endpoint, including independent agent sessions,
    // requires Origin even for cookie-authenticated GET/WebSocket requests.
    let session_route = api
        && ((path.starts_with("/v2/tasks/") || path.starts_with("/v3/tasks/"))
            || path.starts_with("/v3/terminals/"))
        && path.ends_with("/session");
    let local_origin = hosts
        .iter()
        .any(|host| header("origin").as_deref() == Some(format!("http://{host}").as_str()));
    if (session_route && !local_origin)
        || header("sec-fetch-site").is_some_and(|site| site != "same-origin" && site != "none")
        || (req.method() != "GET"
            && req.method() != "HEAD"
            && (!local_origin || header("x-pacer-client").as_deref() != Some("app")))
    {
        return reject(
            StatusCode::FORBIDDEN,
            "forbidden\n",
            app.then_some("Forbidden."),
        );
    }
    Decision::Forward {
        auth: AuthKind::Cookie,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use axum::http::{Method, Request};
    use std::collections::HashMap;

    const PORT: u16 = 4317;
    const SERVICE_TOKEN: &str = "service-token";
    const HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[derive(Debug, PartialEq, Eq)]
    enum Verdict {
        /// Forwarded to the core with the task-grant header.
        Task,
        Rejected(StatusCode),
        /// Bearer, cookie, health or app-auth: never a scoped credential.
        Unscoped,
    }

    fn verdict(method: Method, path: &str, bearer: &str) -> Verdict {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", format!("127.0.0.1:{PORT}"))
            .header("authorization", format!("Bearer {bearer}"))
            .body(())
            .unwrap();
        let ctx = Ctx::with(
            "/nonexistent".into(),
            "/nonexistent".into(),
            HashMap::new(),
            1.0,
        );
        match classify(&request, PORT, SERVICE_TOKEN, &ctx) {
            Decision::Forward {
                auth: AuthKind::Task,
            } => Verdict::Task,
            Decision::Forward { .. } | Decision::Health | Decision::AppAuth => Verdict::Unscoped,
            Decision::Reject(response) => Verdict::Rejected(response.status()),
        }
    }

    const ASSISTANT: &str = "pag_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn assistant_grant_forwards_only_its_one_operation() {
        assert_eq!(
            verdict(Method::POST, "/v3/ops/assistant.tool", ASSISTANT),
            Verdict::Task
        );
        for path in [
            "/v3/ops/assistant.status",
            "/v3/ops/assistant.ask",
            "/v3/ops/task.get",
            "/v3/ops/dispatch.child",
            "/v3/snapshot",
            "/v3/assistant/turns/turn-1/stream",
            "/v2/ops/assistant.tool",
        ] {
            assert_eq!(
                verdict(Method::POST, path, ASSISTANT),
                Verdict::Rejected(StatusCode::FORBIDDEN),
                "{path}"
            );
        }
        assert_eq!(
            verdict(Method::GET, "/v3/ops/assistant.tool", ASSISTANT),
            Verdict::Rejected(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn a_malformed_assistant_grant_is_never_a_task_grant() {
        // Wrong length, uppercase hex and a wrong prefix all fall through to the session path.
        for bearer in [
            "pag_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde".to_string(),
            format!("pag_{}", "A".repeat(64)),
            format!("pag_{}", HEX.replace('a', "g")),
            format!("pwag_{HEX}"),
        ] {
            assert_ne!(
                verdict(Method::POST, "/v3/ops/assistant.tool", &bearer),
                Verdict::Task,
                "{bearer}"
            );
        }
    }

    #[test]
    fn work_and_enforcement_grants_keep_their_own_routes() {
        let work = format!("pwg_{HEX}");
        assert_eq!(
            verdict(Method::POST, "/v3/ops/assistant.tool", &work),
            Verdict::Task
        );
        assert_eq!(
            verdict(Method::POST, "/v3/ops/task.get", &work),
            Verdict::Task
        );
        assert_eq!(
            verdict(Method::POST, "/v3/snapshot", &work),
            Verdict::Rejected(StatusCode::FORBIDDEN)
        );
        let enforcement = format!("pet_{HEX}");
        assert_eq!(
            verdict(
                Method::POST,
                "/v3/ops/dispatch.enforcement.denied",
                &enforcement
            ),
            Verdict::Task
        );
        assert_eq!(
            verdict(Method::POST, "/v3/ops/assistant.tool", &enforcement),
            Verdict::Rejected(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn the_service_bearer_still_authenticates_every_route() {
        for (method, path) in [
            (Method::POST, "/v3/ops/assistant.tool"),
            (Method::GET, "/v3/snapshot"),
        ] {
            assert_eq!(
                verdict(method, path, SERVICE_TOKEN),
                Verdict::Unscoped,
                "{path}"
            );
        }
    }
}
