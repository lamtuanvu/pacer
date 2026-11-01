use serde::Serialize;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
    Unavailable,
    RateLimited,
    PluginTimeout,
    PluginUnavailable,
    PluginRefused,
    CapabilityDenied,
    UnknownPlugin,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct CoreError {
    pub code: Code,
    pub message: String,
    pub hint: Option<String>,
    pub data: Option<Map<String, Value>>,
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

    pub fn data(mut self, data: Map<String, Value>) -> Self {
        self.data = Some(data);
        self
    }

    pub fn http_status(&self) -> u16 {
        match self.code {
            Code::InvalidInput => 400,
            Code::NotAllowed | Code::CapabilityDenied => 403,
            Code::UnknownOp
            | Code::UnknownTask
            | Code::UnknownExecutor
            | Code::NotFound
            | Code::UnknownPlugin => 404,
            Code::Conflict => 409,
            Code::TooLarge => 413,
            Code::PluginRefused => 422,
            Code::RateLimited => 429,
            Code::Internal => 500,
            Code::Unavailable | Code::PluginUnavailable => 503,
            Code::PluginTimeout => 504,
        }
    }

    /// Match `toApiError`: omit empty hints, but retain even empty operation data.
    pub fn body(&self) -> Value {
        let mut error = json!({"code": self.code, "message": self.message});
        if let Some(hint) = self.hint.as_deref().filter(|hint| !hint.is_empty()) {
            error["hint"] = json!(hint);
        }
        if let Some(data) = &self.data {
            error["data"] = json!(data);
        }
        json!({"error": error})
    }

    /// Operation data does not cross the JSON-RPC error boundary.
    pub fn rpc(&self) -> Value {
        let code = match self.code {
            Code::UnknownOp => -32601,
            Code::InvalidInput => -32602,
            _ => -32000,
        };
        let mut data = json!({"code": self.code});
        if let Some(hint) = self.hint.as_deref().filter(|hint| !hint.is_empty()) {
            data["hint"] = json!(hint);
        }
        json!({"code": code, "message": self.message, "data": data})
    }

    pub fn unknown_op(name: &str, names: impl IntoIterator<Item = impl AsRef<str>>) -> Self {
        let mut names: Vec<String> = names
            .into_iter()
            .map(|name| name.as_ref().to_owned())
            .collect();
        names.sort();
        names.dedup();
        Self::new(Code::UnknownOp, format!("unknown operation \"{name}\""))
            .hint(format!("operations: {}", names.join(", ")))
    }
}
