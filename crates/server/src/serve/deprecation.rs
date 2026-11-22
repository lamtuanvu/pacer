//! Protocol 2 deprecation headers (A4). `/v2` is deprecated in 0.18.0 for
//! removal in 0.19.0; responses over the public listener carry the RFC 9694
//! `Deprecation`, `Sunset` and `Link` headers so 2.x callers can find the
//! successor and the removal window. Protocol 3 responses are never annotated.
//!
//! The header values are duplicated in `src/api/deprecation.ts` and must stay
//! string-equal; `test/api-v2-deprecation.test.ts` compares the Rust file
//! against the TypeScript constants.

use axum::{http::HeaderValue, response::Response};

/// Release that removes protocol 2 (the next release after 0.18.0).
pub const V2_REMOVAL_RELEASE: &str = "0.19.0";

/// Unix seconds of 00:00 UTC on the A4 merge date (2026-11-22).
pub const V2_DEPRECATED_AT: u64 = 1_795_305_600;

/// The `Deprecation` header value (`@` plus `V2_DEPRECATED_AT`).
pub const V2_DEPRECATION: &str = "@1795305600";

/// The RFC 8594 `Sunset` header value: `V2_DEPRECATED_AT + 14 days`.
pub const V2_SUNSET: &str = "Sun, 06 Dec 2026 00:00:00 GMT";

/// The successor `Link` header value advertising protocol 3.
pub const V2_LINK: &str = "</v3/hello>; rel=\"successor-version\"";

/// True for a request path that speaks protocol 2.
pub fn is_v2(path: &str) -> bool {
    path == "/v2" || path.starts_with("/v2/")
}

/// Adds the deprecation headers to a protocol 2 response.
pub fn mark(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert("deprecation", HeaderValue::from_static(V2_DEPRECATION));
    headers.insert("sunset", HeaderValue::from_static(V2_SUNSET));
    headers.insert("link", HeaderValue::from_static(V2_LINK));
}
