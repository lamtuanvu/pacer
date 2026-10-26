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
    os::unix::fs::OpenOptionsExt,
};
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKind {
    Bearer,
    Cookie,
    Task,
    Surface,
}

pub enum Decision {
    Reject(Response),
    Health,
    AppAuth,
    Forward { auth: AuthKind },
}

/// A rejected app request needs the core's /_internal/app-page HTML template.
#[derive(Debug, Clone)]
pub struct AppPage {
    pub message: &'static str,
}

pub fn safe_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

pub fn ensure_token(ctx: &Ctx) -> io::Result<String> {
    let path = ctx.pacer_home.join("token");
    match fs::read_to_string(&path) {
        Ok(token) if !token.trim().is_empty() => return Ok(token.trim().to_owned()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::create_dir_all(&ctx.pacer_home)?;
    let token = hex::encode(rand::random::<[u8; 24]>());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    writeln!(file, "{token}")?;
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
        response.extensions_mut().insert(AppPage { message });
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

/** The core verifies the HMAC; the front door forwards only bounded static ticket paths. */
fn surface_ticket_path(path: &str) -> bool {
    if path.len() > 512 {
        return false;
    }
    let mut parts = path.split('/');
    if parts.next() != Some("") || parts.next() != Some("app") || parts.next() != Some("plugins") {
        return false;
    }
    let Some(prefix) = parts.next() else {
        return false;
    };
    if prefix.is_empty()
        || prefix.len() > 32
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || parts.next() != Some("_s")
    {
        return false;
    }
    let Some(ticket) = parts.next() else {
        return false;
    };
    let fields: Vec<&str> = ticket.split('.').collect();
    if fields.len() != 4
        || fields[0] != "s1"
        || fields[1].is_empty()
        || fields[1].len() > 16
        || !fields[1]
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        || fields[2].len() != 32
        || fields[3].len() != 64
        || !fields[2..].iter().all(|field| {
            field
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return false;
    }
    parts.next().is_some()
}

pub fn classify<B>(req: &Request<B>, port: u16, token: &str, ctx: &Ctx) -> Decision {
    let header = |name: &str| {
        req.headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !hosts
        .iter()
        .any(|host| Some(host.as_str()) == header("host"))
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
    if (req.method() == "GET" || req.method() == "HEAD") && surface_ticket_path(path) {
        return Decision::Forward {
            auth: AuthKind::Surface,
        };
    }
    if safe_equal(
        header("authorization").unwrap_or(""),
        &format!("Bearer {token}"),
    ) {
        return Decision::Forward {
            auth: AuthKind::Bearer,
        };
    }
    // Only the core can validate a task grant. The front door limits its transport
    // before forwarding it with the internal generation credential.
    let bearer = header("authorization")
        .unwrap_or("")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    if bearer.len() == 68
        && bearer.starts_with("pwg_")
        && bearer[4..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        if req.method() == "POST" && path.starts_with("/v3/ops/") {
            return Decision::Forward {
                auth: AuthKind::Task,
            };
        }
        return reject(StatusCode::FORBIDDEN, "forbidden\n", None);
    }
    let api = path.starts_with("/v2/") || path.starts_with("/v3/");
    let cookie = header("cookie")
        .unwrap_or("")
        .split(';')
        .map(str::trim)
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
    let session_route = api
        && path
            .get(4..)
            .and_then(|rest| rest.strip_prefix("tasks/"))
            .and_then(|rest| rest.strip_suffix("/session"))
            .is_some_and(|id| {
                !id.is_empty()
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            });
    let local_origin = hosts
        .iter()
        .any(|host| header("origin") == Some(format!("http://{host}").as_str()));
    if (session_route && !local_origin)
        || header("sec-fetch-site").is_some_and(|site| site != "same-origin" && site != "none")
        || (req.method() != "GET"
            && req.method() != "HEAD"
            && (!local_origin || header("x-pacer-client") != Some("app")))
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
