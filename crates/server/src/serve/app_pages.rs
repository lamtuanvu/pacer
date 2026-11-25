//! Native app error and sign-in hop pages, byte-compatible with `src/serve/app-routes.ts`.
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const APP_HEADERS_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// The TypeScript reference embeds the design tokens followed by a template-literal
// newline, then these rules. Keep the bytes exact: the CSP pins their sha256.
const PAGE_STYLE: &str = concat!(
    include_str!("../../../../app/src/ds/tokens.css"),
    "\n",
    "* { box-sizing: border-box; }\n",
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: var(--space-5); background: var(--surface-page); color: var(--ink); font: var(--type-body-size)/var(--type-body-line) var(--font-sans); }\n",
    "main { width: 100%; max-width: 440px; padding: var(--space-8); border: 1px solid var(--line); border-radius: var(--radius-xl); background: var(--surface-card); }\n",
    "h1 { font-size: var(--type-display-size); line-height: var(--type-display-line); }\n",
    "p { color: var(--ink-secondary); }\n",
    ".button { display: inline-block; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--ink); color: var(--ink-on-ink); text-decoration: none; font-weight: var(--type-body-strong-weight); }\n",
    "a:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }\n",
    "input { display: block; width: 100%; margin-top: var(--space-2); padding: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-page); color: var(--ink); font-family: var(--font-mono); }\n",
);

// After sign-in, hop to the app from a same-origin page. A 303 straight to /app/ keeps
// the navigation cross-site when it started outside this origin (the desktop shell's
// own page), so the SameSite=Strict session cookie would be withheld and the app would
// read "Session ended".
const HOP_SCRIPT: &str = r#"location.replace("/app/" + location.hash);"#;
const HOP_PAGE: &str = concat!(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>pacer</title>",
    "<noscript><meta http-equiv=\"refresh\" content=\"0;url=/app/\"></noscript></head>",
    "<body><script>location.replace(\"/app/\" + location.hash);</script></body></html>",
);

fn page_csp() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        let hash = STANDARD.encode(Sha256::digest(PAGE_STYLE.as_bytes()));
        APP_HEADERS_CSP.replace(
            "style-src 'self'",
            &format!("style-src 'self' 'sha256-{hash}'"),
        )
    })
}

fn hop_csp() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        let hash = STANDARD.encode(Sha256::digest(HOP_SCRIPT.as_bytes()));
        APP_HEADERS_CSP.replace(
            "script-src 'self'",
            &format!("script-src 'sha256-{hash}'"),
        )
    })
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn app_headers(response: &mut Response, csp: &str) {
    let headers = response.headers_mut();
    headers.insert(
        "content-security-policy",
        HeaderValue::from_str(csp).expect("CSP is ASCII"),
    );
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "content-type",
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
}

/// The TypeScript `appPage` response, rendered natively for every rejected app request.
pub fn app_page(message: &str, status: StatusCode) -> Response {
    let expired = status == StatusCode::UNAUTHORIZED
        || (status == StatusCode::FORBIDDEN && message.contains("link has expired"));
    let action = if expired { "Sign in again" } else { "Open pacer" };
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>pacer</title><style>{PAGE_STYLE}</style></head><body{}><main><h1>pacer</h1><p>{}</p><a class=\"button\" href=\"{}\">{}</a><section id=\"sign-in\"><p>Run this command in your terminal to open a fresh sign-in link.</p><label for=\"command\">Select and copy command</label><input id=\"command\" aria-label=\"Run pacer open\" readonly value=\"pacer open\"></section></main></body></html>",
        if expired {
            " data-pacer-session-ended=\"true\""
        } else {
            ""
        },
        escape_html(message),
        if expired { "#sign-in" } else { "/app/" },
        action,
    );
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    app_headers(&mut response, page_csp());
    response
}

/// The same-origin page that sets the session cookie and then navigates into the app.
pub fn hop_page(session: &str) -> Response {
    let mut response = Response::new(Body::from(HOP_PAGE));
    app_headers(&mut response, hop_csp());
    let cookie = format!(
        "pacer_session={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        super::sessions::SESSION_SECONDS as u64
    );
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&cookie).expect("cookie is ASCII"),
    );
    response
}

#[cfg(test)]
pub(crate) fn style_hash() -> String {
    STANDARD.encode(Sha256::digest(PAGE_STYLE.as_bytes()))
}

#[cfg(test)]
pub(crate) fn script_hash() -> String {
    STANDARD.encode(Sha256::digest(HOP_SCRIPT.as_bytes()))
}
