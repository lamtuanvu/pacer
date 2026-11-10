use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};
use thiserror::Error;

pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("plugin process is unavailable: {0}")]
    Unavailable(String),
    #[error("plugin call refused by owner: {0}")]
    OwnerRefused(String),
    #[error("plugin frame exceeds 1 MiB")]
    TooLarge,
    #[error("plugin request timed out")]
    Timeout,
    #[error("plugin response is malformed")]
    Malformed,
    #[error("plugin request was cancelled")]
    Cancelled,
}

/// The caller supplies a complete, already sealed environment. No shell is used.
#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}

#[derive(Debug, PartialEq)]
pub enum ProcessFrame {
    Response {
        id: u64,
        result: Value,
    },
    Error {
        id: u64,
        error: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
        metadata: Option<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
}

pub fn frame(value: Value) -> Result<Vec<u8>, ProcessError> {
    let mut bytes = crate::js_canonical_json(&value)
        .map_err(|_| ProcessError::Malformed)?
        .into_bytes();
    bytes.push(b'\n');
    if bytes.len() > MAX_LINE_BYTES {
        return Err(ProcessError::TooLarge);
    }
    Ok(bytes)
}

pub fn parse_frame(line: &[u8]) -> Result<ProcessFrame, ProcessError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(ProcessError::TooLarge);
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| ProcessError::Malformed)?;
    let object = value.as_object().ok_or(ProcessError::Malformed)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(ProcessError::Malformed);
    }
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        return Ok(match object.get("id") {
            Some(id) if !id.is_null() => ProcessFrame::Request {
                id: id.clone(),
                method: method.into(),
                params,
                metadata: object.get("_meta").cloned(),
            },
            _ => ProcessFrame::Notification {
                method: method.into(),
                params,
            },
        });
    }
    let id = object
        .get("id")
        .and_then(crate::js_semantics::safe_u64)
        .ok_or(ProcessError::Malformed)?;
    if let Some(error) = object.get("error") {
        return Ok(ProcessFrame::Error {
            id,
            error: error.clone(),
        });
    }
    Ok(ProcessFrame::Response {
        id,
        result: object
            .get("result")
            .cloned()
            .ok_or(ProcessError::Malformed)?,
    })
}

#[cfg(test)]
mod tests;
