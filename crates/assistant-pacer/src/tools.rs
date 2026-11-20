//! Rig tools that forward each call to `capability.assistant.tool`.
//!
//! Implements [`ToolDyn`] directly (not [`Tool`]) so the host's result text is returned
//! as-is. Rig's blanket `Tool` → `ToolDyn` adapter JSON-encodes `Output`, which would
//! turn a `String` into a quoted JSON string literal in the tool message.

use crate::delta;
use pacer_plugin::{Host, Progress};
use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ForwardError(String);

/// One host-declared assistant tool, invoked through the host capability.
#[derive(Clone)]
pub struct HostTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub turn_id: String,
    pub host: Host,
    pub progress: Progress,
    /// Shared across every tool registered for this turn.
    pub rounds: Arc<AtomicUsize>,
    pub max_rounds: usize,
}

impl ToolDyn for HostTool {
    fn name(&self) -> String {
        self.name.clone()
    }

    fn definition(&self, _prompt: String) -> WasmBoxedFuture<'_, ToolDefinition> {
        let def = ToolDefinition {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        };
        Box::pin(async move { def })
    }

    fn call(&self, args: String) -> WasmBoxedFuture<'_, Result<String, ToolError>> {
        let this = self.clone();
        Box::pin(async move {
            let used = this.rounds.fetch_add(1, Ordering::SeqCst);
            if used >= this.max_rounds {
                return Err(ToolError::ToolCallError(Box::new(ForwardError(format!(
                    "stopped after {} tool rounds",
                    this.max_rounds
                )))));
            }
            delta::activity(
                &this.progress,
                &this.turn_id,
                &format!("Using {}…", this.name),
            );
            let args: Value =
                serde_json::from_str(&args).map_err(ToolError::JsonError)?;
            let result = this
                .host
                .call(
                    "capability.assistant.tool",
                    json!({
                        "turnId": this.turn_id,
                        "name": this.name,
                        "params": args,
                    }),
                )
                .await
                .map_err(|e| ToolError::ToolCallError(Box::new(ForwardError(e.message))))?;
            let content = result
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            // Pass through as plain text — do not JSON-encode again.
            Ok(content)
        })
    }
}
