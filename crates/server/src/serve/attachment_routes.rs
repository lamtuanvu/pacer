#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

//! Native `/v3/attachments` routes, ported from `src/serve/attachment-routes.ts`.
//!
//! The caller has already checked Host and bearer/cookie/Origin auth. Uploads
//! stream each body frame straight to the private temp file so the first byte
//! past a cap is refused without buffering the whole attachment in memory.
use axum::{
    body::Body,
    http::{HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_store::{
    TaskStore,
    attachments::{self, UploadInput},
};
use serde_json::{Value, json};

/// Match `^\/v3\/attachments(?:\/[^/]+)?$` after the auth layer has normalized paths.
pub fn is_attachment_path(path: &str) -> bool {
    path == "/v3/attachments"
        || path
            .strip_prefix("/v3/attachments/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}

fn param(query: &str, name: &str) -> Option<String> {
    form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn error(code: Code, message: impl Into<String>) -> CoreError {
    CoreError::new(code, message)
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    response
}

fn fail(response: Result<Response, CoreError>) -> Response {
    match response {
        Ok(response) => response,
        Err(error) => json_response(
            StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            error.body(),
        ),
    }
}

/// `decodeURIComponent`: percent escapes only, with UTF-8 validation. A malformed
/// escape is reported as the TypeScript route's `Invalid filename encoding`.
fn decode_component(input: &str) -> Result<String, CoreError> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| error(Code::InvalidInput, "Invalid filename encoding"))?;
            let high = (hex[0] as char).to_digit(16);
            let low = (hex[1] as char).to_digit(16);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(error(Code::InvalidInput, "Invalid filename encoding"));
            };
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| error(Code::InvalidInput, "Invalid filename encoding"))
}

/// `encodeURIComponent`, used in `Content-Disposition` for the download name.
fn encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn store(ctx: &Ctx) -> Result<TaskStore, CoreError> {
    TaskStore::open(&ctx.pacer_home)
        .map_err(|failed| error(Code::Internal, format!("attachment store: {failed}")))
}

/// Handle an attachment request. Only called after [`is_attachment_path`] matched.
pub async fn handle(req: Request<Body>, ctx: &Ctx) -> Response {
    let id = req
        .uri()
        .path()
        .strip_prefix("/v3/attachments/")
        .map(str::to_owned);
    let query = req.uri().query().unwrap_or("").to_owned();
    let draft = param(&query, "draft").unwrap_or_default();
    let batch = param(&query, "batch").unwrap_or_default();
    let method = req.method().clone();
    match (method, id) {
        (Method::POST, None) => {
            let name = req
                .headers()
                .get("x-pacer-filename")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("attachment");
            let name = match decode_component(name) {
                Ok(name) => name,
                Err(failed) => return fail(Err(failed)),
            };
            let mime = req
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            let mut body = req.into_body();
            let result = async {
                let store = TaskStore::open(&ctx.pacer_home).map_err(|failed| {
                    error(Code::Internal, format!("attachment store: {failed}"))
                })?;
                let mut upload = attachments::begin_upload(
                    store,
                    ctx.now,
                    UploadInput {
                        draft_id: &draft,
                        batch_id: &batch,
                        name: &name,
                        mime: &mime,
                    },
                )?;
                while let Some(frame) = body.frame().await {
                    let frame = frame.map_err(|failed| {
                        error(Code::InvalidInput, format!("body read failed: {failed}"))
                    })?;
                    if let Some(chunk) = frame.data_ref() {
                        upload.push(chunk)?;
                    }
                }
                let meta = upload.finish()?;
                Ok(json_response(
                    StatusCode::CREATED,
                    json!({
                        "id": meta.id,
                        "name": meta.name,
                        "mime": meta.mime,
                        "size": meta.size,
                    }),
                ))
            }
            .await;
            fail(result)
        }
        (Method::GET, None) => {
            let result = (|| {
                let mut store = store(ctx)?;
                let files =
                    attachments::list_draft(&mut store, &draft, ctx.now)?.ok_or_else(|| {
                        error(Code::NotFound, "Attachment draft expired or does not exist")
                    })?;
                Ok(json_response(
                    StatusCode::OK,
                    Value::Array(
                        files
                            .iter()
                            .map(attachments::AttachmentMeta::as_json)
                            .collect(),
                    ),
                ))
            })();
            fail(result)
        }
        (Method::GET, Some(id)) => {
            let result = async {
                let mut store = store(ctx)?;
                let file = attachments::read(&mut store, &draft, &id, ctx.now)?;
                let bytes = tokio::fs::read(&file.path).await.map_err(|failed| {
                    error(Code::Internal, format!("attachment read: {failed}"))
                })?;
                let mime = HeaderValue::from_str(&file.meta.mime)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
                let disposition = format!(
                    "attachment; filename*=UTF-8''{}",
                    encode_component(&file.meta.name)
                );
                let disposition = HeaderValue::from_str(&disposition).unwrap_or_else(|_| {
                    HeaderValue::from_static("attachment; filename=attachment")
                });
                let mut response = Response::new(Body::from(bytes));
                response.headers_mut().insert("content-type", mime);
                response.headers_mut().insert(
                    "x-content-type-options",
                    HeaderValue::from_static("nosniff"),
                );
                response.headers_mut().insert(
                    "content-security-policy",
                    HeaderValue::from_static("default-src 'none'"),
                );
                response
                    .headers_mut()
                    .insert("cache-control", HeaderValue::from_static("no-store"));
                response
                    .headers_mut()
                    .insert("content-disposition", disposition);
                Ok(response)
            }
            .await;
            fail(result)
        }
        (Method::DELETE, Some(id)) => {
            let result = (|| {
                let mut store = store(ctx)?;
                attachments::delete(&mut store, &draft, &id, ctx.now)?;
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::NO_CONTENT;
                Ok(response)
            })();
            fail(result)
        }
        _ => (StatusCode::METHOD_NOT_ALLOWED, "Method not allowed").into_response(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    fn ctx(dir: &std::path::Path) -> Ctx {
        Ctx::with(
            dir.into(),
            dir.join("pacer"),
            HashMap::new(),
            1_800_000_000.0,
        )
    }

    async fn body(response: Response) -> Vec<u8> {
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    #[test]
    fn paths_and_filename_encoding_match_the_typescript_route() {
        assert!(is_attachment_path("/v3/attachments"));
        assert!(is_attachment_path("/v3/attachments/one"));
        assert!(!is_attachment_path("/v3/attachments/one/two"));
        assert!(!is_attachment_path("/v3/attachment"));
        assert_eq!(decode_component("hello%2Etxt").unwrap(), "hello.txt");
        assert_eq!(decode_component("hello.txt").unwrap(), "hello.txt");
        assert_eq!(
            decode_component("%ZZ").unwrap_err().message,
            "Invalid filename encoding"
        );
        assert_eq!(
            decode_component("%C3").unwrap_err().code,
            Code::InvalidInput
        );
        assert_eq!(encode_component("a b/é"), "a%20b%2F%C3%A9");
        assert_eq!(encode_component("!~*'()"), "!~*'()");
    }

    #[tokio::test]
    async fn upload_list_download_delete_and_method_guards() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let draft = {
            let mut store = store(&ctx).unwrap();
            attachments::create_draft(&mut store, ctx.now).unwrap()
        };

        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/v3/attachments?draft={draft}&batch=one"))
            .header("x-pacer-filename", "hello%2Etxt")
            .header("content-type", "text/plain")
            .body(Body::from("hello"))
            .unwrap();
        let created = handle(request, &ctx).await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let created: Value = serde_json::from_slice(&body(created).await).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["name"], "hello.txt");
        assert_eq!(created["mime"], "text/plain");
        assert_eq!(created["size"], 5);

        let listing = handle(
            Request::builder()
                .uri(format!("/v3/attachments?draft={draft}"))
                .body(Body::empty())
                .unwrap(),
            &ctx,
        )
        .await;
        assert_eq!(listing.status(), StatusCode::OK);
        let listing: Value = serde_json::from_slice(&body(listing).await).unwrap();
        assert_eq!(listing[0]["id"], id);

        let downloaded = handle(
            Request::builder()
                .uri(format!("/v3/attachments/{id}?draft={draft}"))
                .body(Body::empty())
                .unwrap(),
            &ctx,
        )
        .await;
        assert_eq!(downloaded.status(), StatusCode::OK);
        assert_eq!(downloaded.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            downloaded.headers()["content-security-policy"],
            "default-src 'none'"
        );
        assert_eq!(downloaded.headers()["cache-control"], "no-store");
        assert_eq!(
            downloaded.headers()["content-disposition"],
            "attachment; filename*=UTF-8''hello.txt"
        );
        assert_eq!(body(downloaded).await, b"hello");

        let foreign = handle(
            Request::builder()
                .uri(format!("/v3/attachments/{id}?draft=foreign"))
                .body(Body::empty())
                .unwrap(),
            &ctx,
        )
        .await;
        assert_eq!(foreign.status(), StatusCode::NOT_FOUND);

        let removed = handle(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/v3/attachments/{id}?draft={draft}"))
                .body(Body::empty())
                .unwrap(),
            &ctx,
        )
        .await;
        assert_eq!(removed.status(), StatusCode::NO_CONTENT);

        let listing = handle(
            Request::builder()
                .uri(format!("/v3/attachments?draft={draft}"))
                .body(Body::empty())
                .unwrap(),
            &ctx,
        )
        .await;
        let listing: Value = serde_json::from_slice(&body(listing).await).unwrap();
        assert_eq!(listing, json!([]));

        let wrong_method = handle(
            Request::builder()
                .method(Method::PUT)
                .uri("/v3/attachments")
                .body(Body::empty())
                .unwrap(),
            &ctx,
        )
        .await;
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body(wrong_method).await, b"Method not allowed");
    }

    #[tokio::test]
    async fn a_bad_filename_is_refused_before_any_bytes_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let draft = {
            let mut store = store(&ctx).unwrap();
            attachments::create_draft(&mut store, ctx.now).unwrap()
        };
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/v3/attachments?draft={draft}&batch=one"))
            .header("x-pacer-filename", "bad%ZZ")
            .header("content-type", "text/plain")
            .body(Body::from("hello"))
            .unwrap();
        let response = handle(request, &ctx).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let value: Value = serde_json::from_slice(&body(response).await).unwrap();
        assert_eq!(value["error"]["code"], "invalid_input");
        assert_eq!(value["error"]["message"], "Invalid filename encoding");
    }
}
