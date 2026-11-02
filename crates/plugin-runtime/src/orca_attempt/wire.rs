use super::*;
use crate::{OrcaSessionOwner, Utf16String, WireReply};
impl OrcaSessionOwner for OrcaAttempt {
    fn session_id(&self) -> &str {
        &self.id
    }
    fn task_id(&self) -> &str {
        &self.task_id
    }
    fn attempt(&self) -> u64 {
        self.attempt
    }
    fn executor(&self) -> &str {
        &self.spec.executor
    }
    async fn invoke(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        self.invoke_wire(method, params)
            .await?
            .into_value()
            .map_err(|_| BrokerError::Invalid("UTF-16 reply requires lossless wire delivery"))
    }
    async fn invoke_wire(&mut self, method: &str, params: Value) -> Result<WireReply, BrokerError> {
        let result = self.invoke_value(method, params).await?;
        let mut wire = WireReply::new(result);
        if method == "finish" {
            let mapped = self.mapped()?;
            let summary = mapped["summary"].as_str().unwrap_or("");
            let tail = mapped["tail"].as_str().unwrap_or("");
            let report = if self.reattach {
                summary.into()
            } else {
                self.spec
                    .notes
                    .iter()
                    .map(String::as_str)
                    .chain([summary])
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };
            for (path, text, limit) in [
                ("/exec/stdout", summary, 262144),
                ("/exec/stderr", tail, 262144),
                ("/report", report.as_str(), 4000),
            ] {
                wire.replace(
                    path,
                    Utf16String::slice(
                        text,
                        crate::js_semantics::utf16_len(text).saturating_sub(limit),
                        usize::MAX,
                    ),
                );
            }
        }
        // Keep the original host observations, then apply JS slice to UTF-16
        // units only at delivery. Never serialize U+FFFD as a surrogate's value.
        let source = match method {
            "wait" => self.waited.as_ref(),
            "lookup" => Some(&self.found),
            _ => None,
        };
        if let Some(source) = source {
            for (key, limit, tail) in [
                ("outcome", 256, false),
                ("state", 256, false),
                ("error", 4096, false),
                ("reason", 4096, false),
                ("subject", 32000, true),
                ("body", 32000, true),
                ("tail", 65536, true),
            ] {
                if let Some(text) = source[key].as_str() {
                    let text = if key == "reason" {
                        let trimmed = crate::js_semantics::trim(text);
                        if trimmed.is_empty() {
                            "unknown"
                        } else {
                            trimmed
                        }
                    } else {
                        text
                    };
                    let length = crate::js_semantics::utf16_len(text);
                    let (start, end) = if tail {
                        (length.saturating_sub(limit), usize::MAX)
                    } else {
                        (0, limit)
                    };
                    wire.replace(&format!("/{key}"), Utf16String::slice(text, start, end));
                }
            }
        }
        Ok(wire)
    }
}
