use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    UnknownOp,
    UnknownTask,
    InvalidInput,
    UnknownExecutor,
    Conflict,
    NotAllowed,
    NotFound,
    TooLarge,
    Internal,
    PluginTimeout,
    PluginUnavailable,
    PluginRefused,
    CapabilityDenied,
    UnknownPlugin,
}

/// One typed operation error; transport-specific envelopes are built at the edge.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct CoreError {
    pub code: Code,
    pub message: String,
    pub hint: Option<String>,
    pub data: Option<Box<Map<String, Value>>>,
}

impl CoreError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
            data: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn http_status(&self) -> u16 {
        match self.code {
            Code::InvalidInput => 400,
            Code::Conflict => 409,
            Code::NotAllowed | Code::CapabilityDenied => 403,
            Code::TooLarge => 413,
            Code::Internal => 500,
            Code::PluginTimeout => 504,
            Code::PluginUnavailable => 503,
            Code::PluginRefused => 422,
            Code::UnknownOp
            | Code::UnknownTask
            | Code::UnknownExecutor
            | Code::NotFound
            | Code::UnknownPlugin => 404,
        }
    }

    pub fn body(&self) -> Value {
        let mut error = Map::from_iter([
            ("code".into(), json!(self.code)),
            ("message".into(), json!(self.message)),
        ]);
        if let Some(hint) = self.hint.as_ref().filter(|hint| !hint.is_empty()) {
            error.insert("hint".into(), json!(hint));
        }
        if let Some(data) = &self.data {
            error.insert("data".into(), Value::Object(data.as_ref().clone()));
        }
        json!({ "error": error })
    }

    pub fn rpc(&self) -> Value {
        let number = match self.code {
            Code::UnknownOp => -32601,
            Code::InvalidInput => -32602,
            _ => -32000,
        };
        let mut data = Map::from_iter([("code".into(), json!(self.code))]);
        if let Some(hint) = self.hint.as_ref().filter(|hint| !hint.is_empty()) {
            data.insert("hint".into(), json!(hint));
        }
        json!({ "code": number, "message": self.message, "data": data })
    }
}
