#![allow(clippy::result_large_err)] // CoreError is the established operation boundary.
//! Fixed bridge to the existing TS endpoint plugin adapter; no caller-controlled
//! operation, destination, arguments or credential material crosses this channel.
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;

pub(crate) fn error(value: &Value) -> CoreError {
    let body = if value["code"].is_number() {
        value.get("data").unwrap_or(value)
    } else {
        value
    };
    let code = match body["code"].as_str().unwrap_or("") {
        "unknown_op" => Code::UnknownOp,
        "unknown_task" => Code::UnknownTask,
        "invalid_input" => Code::InvalidInput,
        "unknown_executor" => Code::UnknownExecutor,
        "not_found" => Code::NotFound,
        "too_large" => Code::TooLarge,
        "rate_limited" => Code::RateLimited,
        "internal" => Code::Internal,
        "plugin_timeout" => Code::PluginTimeout,
        "plugin_unavailable" => Code::PluginUnavailable,
        "plugin_refused" => Code::PluginRefused,
        "capability_denied" => Code::CapabilityDenied,
        "unknown_plugin" => Code::UnknownPlugin,
        "not_allowed" => Code::NotAllowed,
        "conflict" => Code::Conflict,
        "unavailable" => Code::Unavailable,
        _ => Code::InvalidInput,
    };
    let mut error = CoreError::new(
        code,
        value["message"]
            .as_str()
            .unwrap_or("endpoint synchronization failed"),
    );
    error.hint = body.get("hint").and_then(Value::as_str).map(str::to_owned);
    error.data = body.get("data").and_then(Value::as_object).cloned();
    error
}
#[allow(clippy::result_large_err)]
pub(crate) async fn http(target: Option<(u16, String)>, op: &str) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) =
            target.ok_or_else(|| CoreError::new(Code::Unavailable, "pacer core is restarting"))?;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!(
                "http://127.0.0.1:{port}/_internal/native-config-finish"
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({"op":op}).to_string()))
            .map_err(|_| {
                CoreError::new(Code::Unavailable, "endpoint synchronization unavailable")
            })?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client.request(request).await.map_err(|_| {
            CoreError::new(Code::Unavailable, "endpoint synchronization unavailable")
        })?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| CoreError::new(Code::Unavailable, "endpoint synchronization unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            CoreError::new(
                Code::Unavailable,
                "invalid endpoint synchronization response",
            )
        })?;
        if let Some(e) = value.get("error") {
            Err(error(e))
        } else {
            Ok(Value::Null)
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(60), run)
        .await
        .map_err(|_| CoreError::new(Code::Unavailable, "endpoint synchronization timed out"))?
}

pub(crate) async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    op: &str,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({"jsonrpc":"2.0","id":id,"method":"_internal.native-config.finish","params":{"key":key,"op":op}});
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "config sync encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| CoreError::new(Code::Unavailable, "config sync channel closed"))?;
    core.flush()
        .await
        .map_err(|_| CoreError::new(Code::Unavailable, "config sync channel closed"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        receive_sync(replies, &id),
    )
    .await
    .map_err(|_| CoreError::new(Code::Unavailable, "config sync timed out"))?
}
async fn receive_sync(
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    id: &str,
) -> Result<Value, CoreError> {
    while let Some(value) = replies.recv().await {
        if value.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        return if let Some(e) = value.get("error") {
            Err(error(e))
        } else {
            Ok(Value::Null)
        };
    }
    Err(CoreError::new(
        Code::Unavailable,
        "config sync channel closed",
    ))
}
#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn every_api_error_code_and_http_data_survive_the_bridge() {
        for code in [
            Code::UnknownOp,
            Code::UnknownTask,
            Code::InvalidInput,
            Code::UnknownExecutor,
            Code::Conflict,
            Code::NotAllowed,
            Code::NotFound,
            Code::TooLarge,
            Code::Internal,
            Code::Unavailable,
            Code::RateLimited,
            Code::PluginTimeout,
            Code::PluginUnavailable,
            Code::PluginRefused,
            Code::CapabilityDenied,
            Code::UnknownPlugin,
        ] {
            let original = CoreError::new(code, "sync failed")
                .hint("retry")
                .data(serde_json::from_value(serde_json::json!({"key": "value"})).unwrap());
            assert_eq!(error(&original.body()["error"]), original);
            let rpc = error(&original.rpc());
            assert_eq!(rpc.code, code);
            assert_eq!(rpc.message, original.message);
            assert_eq!(rpc.hint, original.hint);
            assert_eq!(rpc.data, None); // The reference RPC transport omits operation data.
        }
    }
    #[tokio::test]
    async fn late_sync_response_cannot_complete_the_next_edit() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(serde_json::json!({"id":"late","result":null}))
            .unwrap();
        tx.send(serde_json::json!({"id":"current","error":{"code":"plugin_refused","message":"current failed"}})).unwrap();
        assert_eq!(
            receive_sync(&mut rx, "current").await.unwrap_err().code,
            Code::PluginRefused
        );
    }
}
