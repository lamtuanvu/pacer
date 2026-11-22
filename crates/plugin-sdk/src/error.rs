use std::fmt;

/// An error with a code the host maps (invalid_input, not_allowed, plugin_unavailable, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub reason: Option<String>,
}

impl PluginError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
            reason: None,
        }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
    /// `{"code", "hint"?, "reason"?}`. `reason` is kept only for code
    /// `capability_denied` and reason `credential_reflection`
    /// (packages/plugin-sdk/src/index.ts:62-63).
    pub fn data(&self) -> serde_json::Value {
        let mut d = serde_json::json!({ "code": self.code });
        if let Some(h) = &self.hint {
            d["hint"] = serde_json::Value::String(h.clone());
        }
        if let Some(r) = &self.reason
            && self.code == "capability_denied"
            && r == "credential_reflection"
        {
            d["reason"] = serde_json::Value::String(r.clone());
        }
        d
    }
}
impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for PluginError {}
