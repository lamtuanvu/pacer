//! Authenticated web assets from the same generated bundle used by the TypeScript server.
use axum::{
    body::Body,
    http::{HeaderValue, Method, Request, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

#[derive(Deserialize)]
struct Asset {
    path: String,
    #[serde(rename = "type")]
    content_type: String,
    text: String,
}

fn assets() -> &'static [Asset] {
    static ASSETS: OnceLock<Vec<Asset>> = OnceLock::new();
    ASSETS.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/app-assets.json")))
            .unwrap_or_else(|error| panic!("invalid embedded web app: {error}"))
    })
}

/// The code flow and error pages remain on the TypeScript fallback. A missing
/// static path also falls through so its HTML error is byte-for-byte identical.
pub fn route<B>(req: &Request<B>) -> Option<Response> {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return None;
    }
    let path = req.uri().path().strip_prefix("/app/")?;
    if path == "auth" {
        return None;
    }
    // Node's extname ignores trailing separators, including on missing assets.
    let basename = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path);
    let has_extension = basename.rfind('.').is_some_and(|position| position > 0);
    let file = assets()
        .iter()
        .find(|asset| asset.path == if path.is_empty() { "index.html" } else { path })
        .or_else(|| {
            (!has_extension)
                .then(|| assets().iter().find(|asset| asset.path == "index.html"))
                .flatten()
        })?;
    let mut response = Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "content-type",
        HeaderValue::from_str(&file.content_type).ok()?,
    );
    let body = if file.path == "index.html" {
        let nonce = STANDARD.encode(rand::random::<[u8; 24]>());
        let csp = CSP.replace(
            "style-src 'self'",
            &format!("style-src 'self' 'nonce-{nonce}'"),
        );
        headers.insert("content-security-policy", HeaderValue::from_str(&csp).ok()?);
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
        file.text.replacen(
            "</head>",
            &format!("<meta name=\"pacer-style-nonce\" content=\"{nonce}\"></head>"),
            1,
        )
    } else {
        headers.insert("content-security-policy", HeaderValue::from_static(CSP));
        headers.insert("cache-control", HeaderValue::from_static("no-cache"));
        let tag = format!(
            "\"{}\"",
            &hex::encode(Sha256::digest(file.text.as_bytes()))[..32]
        );
        headers.insert("etag", HeaderValue::from_str(&tag).ok()?);
        if super::header_value(req.headers(), "if-none-match").as_deref() == Some(tag.as_str()) {
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            return Some(response);
        }
        file.text.clone()
    };
    if req.method() == Method::GET {
        *response.body_mut() = Body::from(body);
    }
    Some(response)
}
