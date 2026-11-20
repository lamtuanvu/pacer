//! Rig tools that forward each call to `capability.assistant.tool`.

use crate::delta;
use pacer_plugin::{Host, Progress};
use rig::completion::ToolDefinition;
use rig::tool::Tool;
use serde_json::{Value, json};
use std::future::Future;
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

impl Tool for HostTool {
    // Overridden by [`name`](Self::name); each instance carries its own name.
    const NAME: &'static str = "host_tool";

    type Error = ForwardError;
    type Args = Value;
    type Output = String;

    fn name(&self) -> String {
        self.name.clone()
    }

    fn definition(
        &self,
        _prompt: String,
    ) -> impl Future<Output = ToolDefinition> + Send + Sync {
        let def = ToolDefinition {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        };
        async move { def }
    }

    fn call(
        &self,
        args: Self::Args,
    ) -> impl Future<Output = Result<Self::Output, Self::Error>> + Send {
        let this = self.clone();
        async move {
            let used = this.rounds.fetch_add(1, Ordering::SeqCst);
            if used >= this.max_rounds {
                return Err(ForwardError(format!(
                    "stopped after {} tool rounds",
                    this.max_rounds
                )));
            }
            delta::activity(
                &this.progress,
                &this.turn_id,
                &format!("Using {}…", this.name),
            );
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
                .map_err(|e| ForwardError(e.message))?;
            let content = result
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            Ok(content)
        }
    }
}
