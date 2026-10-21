use pacer_foundation::ctx::Ctx;
use serde_json::{Value, json};

pub const NATIVE_OPS: &[&str] = &[];

#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub data: Option<Value>,
}

impl ApiError {
    /// Match protocol.ts rpcError: operation data is deliberately omitted.
    pub fn to_rpc(&self) -> Value {
        let code = match self.code.as_str() {
            "unknown_op" => -32601,
            "invalid_input" => -32602,
            _ => -32000,
        };
        let mut data = json!({"code": self.code});
        if let Some(hint) = self.hint.as_ref().filter(|hint| !hint.is_empty()) {
            data["hint"] = json!(hint);
        }
        json!({"code": code, "message": self.message, "data": data})
    }
}

pub fn call_native(_ctx: &Ctx, _op: &str, _params: &Value) -> Option<Result<Value, ApiError>> {
    None
}
