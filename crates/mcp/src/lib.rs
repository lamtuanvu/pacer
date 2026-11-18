//! MCP tool transport, kept separate from the default TypeScript MCP entry point.
//!
//! The host supplies a backend implementing the existing tool semantics. This library
//! owns the public catalog, Zod-compatible input validation/transforms and MCP envelopes;
//! it performs no state writes or authorization itself. In grant mode the backend MUST
//! use the authenticated scoped service connection, never owner/in-process operations.
//! A backend receives tool names (not API operation names), after unknown-key stripping.
//! It must retain the per-connection driving lease and caller identity for its lifetime.
mod json;
mod requests;
mod validation;
mod wire;

pub use json::{from_value, number as js_number, parse_json};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};
pub use wire::{run_stdio, stringify as stringify_json, stringify_backend_json};

pub type BackendFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Domain seam: return the structured tool value, or its user-facing error message.
/// Values/strings use the lossless JS encoding from `parse_json`. Serialize with
/// `stringify_json`; use `from_value` to encode native Rust-produced values.
/// Planner task summaries, direct strategy calls (including activeOk/who), injected
/// spawning, executor refusal and grant authorization remain backend responsibilities.
pub trait Backend: Send + Sync + 'static {
    fn call(&self, name: &str, arguments: Value) -> BackendFuture<'_>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Planner,
    Grant,
}

pub struct McpServer<B> {
    mode: Mode,
    version: String,
    tools: Vec<Value>,
    backend: B,
}

impl<B: Backend> McpServer<B> {
    pub fn new(
        mode: Mode,
        version: impl Into<String>,
        backend: B,
    ) -> Result<Self, serde_json::Error> {
        // Captured TS contracts; the cross-language suite checks every description and
        // schema against the live reference. No test fixtures are loaded at runtime.
        let catalog: Value = serde_json::from_str(include_str!("catalog.json"))?;
        let key = if mode == Mode::Planner {
            "planner"
        } else {
            "grant"
        };
        let tools = catalog[key].as_array().cloned().unwrap_or_default();
        Ok(Self {
            mode,
            version: json::from_string(&version.into()),
            tools,
            backend,
        })
    }

    /// Handle one JSON-RPC value. Notifications have no response. Input and output
    /// streams are deliberately supplied by the caller; this does not install a server.
    /// Requests use the lossless string representation from `parse_json` or
    /// `from_value`; serialize the returned value with `stringify_json` too.
    pub async fn handle(&self, request: Value) -> Option<Value> {
        let id = request.get("id");
        let method = request.get("method").and_then(Value::as_str);
        if !request.is_object()
            || request["jsonrpc"] != "2.0"
            || method.is_none()
            || id.is_some_and(|id| !id.is_string() && !id.is_number())
        {
            return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
        }
        let id = id?.clone();
        let params = &request["params"];
        if matches!(
            method,
            Some("initialize" | "tools/call" | "tools/list" | "ping")
        ) && let Some(error) =
            requests::validate(method.unwrap_or_default(), request.get("params"))
        {
            return Some(json!({"jsonrpc":"2.0","id":id,"error":error}));
        }
        let result = match method.unwrap_or_default() {
            "initialize" => {
                let requested = params["protocolVersion"].as_str().unwrap_or_default();
                let supported = [
                    "2025-11-25",
                    "2025-06-18",
                    "2025-03-26",
                    "2024-11-05",
                    "2024-10-07",
                ];
                let protocol = if supported.contains(&requested) {
                    requested
                } else {
                    supported[0]
                };
                json!({"protocolVersion":protocol,"capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"pacer","version":self.version}})
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools":self.tools}),
            "tools/call" => {
                let Some(name) = params["name"].as_str() else {
                    return Some(rpc_error(id, -32602, "Invalid tools/call params"));
                };
                self.call_tool(
                    name,
                    params
                        .get("arguments")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                )
                .await
            }
            _ => return Some(rpc_error(id, -32601, "Method not found")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }

    async fn call_tool(&self, name: &str, arguments: Value) -> Value {
        let Some(tool) = self.tools.iter().find(|t| t["name"] == name) else {
            return tool_error(format!("MCP error -32602: Tool {name} not found"));
        };
        let arguments = match validation::validate(self.mode, name, &tool["inputSchema"], arguments)
        {
            Ok(arguments) => arguments,
            Err(message) => {
                return tool_error(format!(
                    "MCP error -32602: Input validation error: Invalid arguments for tool {name}: {message}"
                ));
            }
        };
        match self.backend.call(name, arguments).await {
            Ok(value) => structured(value, false),
            Err(message)
                if self.mode == Mode::Grant
                    || name.starts_with("strategy_")
                    || name == "dispatch_preview" =>
            {
                structured(json!({"error":message}), true)
            }
            Err(message) => tool_error(message),
        }
    }
}

fn structured(value: Value, error: bool) -> Value {
    let text = wire::stringify(&value, Some(1));
    let mut result = json!({"content":[{"type":"text","text":json::from_string(&text)}],"structuredContent":value});
    if error {
        result["isError"] = true.into();
    }
    result
}

fn tool_error(message: String) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
