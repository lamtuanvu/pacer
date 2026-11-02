use super::{Backend, McpServer, rpc_error};
use serde_json::Value;
use std::{io, sync::Arc};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
    task::JoinSet,
};

/// Concurrent newline-delimited MCP JSON-RPC. EOF drains in-flight calls. A long
/// task_wait/msg_wait never prevents another client request from being handled.
/// Write failures cancel outstanding calls rather than leaving a silent server.
pub async fn run_stdio<B, R, W>(server: McpServer<B>, input: R, mut output: W) -> io::Result<()>
where
    B: Backend,
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let server = Arc::new(server);
    let mut lines = input.lines();
    let (tx, mut rx) = mpsc::channel::<Value>(32);
    let mut calls = JoinSet::new();
    let mut eof = false;
    loop {
        tokio::select! {
            line = lines.next_line(), if !eof => match line? {
                Some(line) if line.trim().is_empty() => {},
                Some(line) => {
                    let server = Arc::clone(&server);
                    let tx = tx.clone();
                    calls.spawn(async move {
                        let reply = match super::json::parse_json(&line) {
                            Ok(value) => server.handle(value).await,
                            Err(_) => Some(rpc_error(Value::Null, -32700, "Parse error")),
                        };
                        if let Some(reply) = reply { let _ = tx.send(reply).await; }
                    });
                }
                None => eof = true,
            },
            Some(reply) = rx.recv() => {
                output.write_all(stringify(&reply, None).as_bytes()).await?;
                output.write_all(b"\n").await?;
                output.flush().await?;
            },
            Some(result) = calls.join_next(), if !calls.is_empty() => {
                result.map_err(io::Error::other)?;
            },
        }
        if eof && calls.is_empty() && rx.is_empty() {
            return Ok(());
        }
    }
}

pub(super) fn number_value(number: f64) -> Value {
    // Keep the f64 bits parsed by Rust's correctly rounded standard parser.
    // Re-parsing shortest decimal text through serde can shift by one ULP.
    serde_json::Number::from_f64(number)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

pub fn stringify(value: &Value, indent: Option<usize>) -> String {
    stringify_impl(value, indent, false)
}

/// Lossless backend JSON: nonfinite numbers stay numeric tokens for JavaScript
/// JSON.parse, while public MCP responses use JSON.stringify semantics (null).
pub fn stringify_backend_json(value: &Value) -> String {
    stringify_impl(value, None, true)
}

fn stringify_impl(value: &Value, indent: Option<usize>, preserve_nonfinite: bool) -> String {
    fn visit(
        value: &Value,
        out: &mut String,
        indent: Option<usize>,
        depth: usize,
        preserve_nonfinite: bool,
    ) {
        let gap = |out: &mut String, depth: usize| {
            if let Some(width) = indent {
                out.push('\n');
                out.push_str(&" ".repeat(width * depth));
            }
        };
        match value {
            Value::Number(n) => {
                if let Some(n) = n.as_f64().filter(|n| n.is_finite()) {
                    out.push_str(ryu_js::Buffer::new().format(n));
                } else {
                    out.push_str("null");
                }
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    gap(out, depth + 1);
                    visit(item, out, indent, depth + 1, preserve_nonfinite);
                }
                if !items.is_empty() {
                    gap(out, depth);
                }
                out.push(']');
            }
            Value::Object(items) => {
                // Object.keys enumerates array-index keys numerically before other
                // keys; this matters for arbitrary strategy drafts/results.
                let keys = super::json::object_keys(items);
                out.push('{');
                for (i, key) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    gap(out, depth + 1);
                    out.push_str(&super::json::quote(key));
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    visit(&items[*key], out, indent, depth + 1, preserve_nonfinite);
                }
                if !items.is_empty() {
                    gap(out, depth);
                }
                out.push('}');
            }
            Value::String(_) if super::json::nonfinite(value).is_some() => {
                if preserve_nonfinite {
                    out.push_str(if super::json::nonfinite(value) == Some("-Infinity") {
                        "-1e400"
                    } else {
                        "1e400"
                    });
                } else {
                    out.push_str("null");
                }
            }
            Value::String(text) => out.push_str(&super::json::quote(text)),
            _ => out.push_str(&value.to_string()),
        }
    }
    let mut result = String::new();
    visit(value, &mut result, indent, 0, preserve_nonfinite);
    result
}
