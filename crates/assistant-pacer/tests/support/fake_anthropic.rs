//! In-process Anthropic `/v1/messages` for plugin tests.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct RecordedAnthropicRequest {
    pub body: Value,
    pub api_key: Option<String>,
}

#[derive(Clone)]
pub enum AnthropicScript {
    Text {
        content: String,
        usage: (u64, u64),
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        usage: (u64, u64),
    },
    HttpError {
        status: u16,
        body: String,
    },
}

pub struct FakeAnthropic {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<RecordedAnthropicRequest>>>,
    _shutdown: oneshot::Sender<()>,
    _task: JoinHandle<()>,
}

impl FakeAnthropic {
    pub async fn start(mut script: VecDeque<AnthropicScript>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let reqs = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break };
                        let reqs = reqs.clone();
                        let reply = script.pop_front().unwrap_or(AnthropicScript::Text {
                            content: "fallback".into(),
                            usage: (1, 1),
                        });
                        tokio::spawn(async move {
                            let body = read_http_body(&mut stream).await;
                            let Some((headers, body)) = body else { return };
                            let api_key = headers.lines().find_map(|l| {
                                l.split_once(':').and_then(|(k, v)| {
                                    k.eq_ignore_ascii_case("x-api-key").then(|| v.trim().to_owned())
                                })
                            });
                            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                            assert!(
                                parsed.get("max_tokens").and_then(Value::as_u64).is_some(),
                                "anthropic body must include max_tokens, got {parsed}"
                            );
                            reqs.lock().unwrap().push(RecordedAnthropicRequest {
                                body: parsed,
                                api_key,
                            });
                            let (status, payload) = match reply {
                                AnthropicScript::Text { content, usage } => (
                                    200u16,
                                    json!({
                                        "id": "msg_test",
                                        "type": "message",
                                        "role": "assistant",
                                        "model": "claude-test",
                                        "content": [{"type": "text", "text": content}],
                                        "stop_reason": "end_turn",
                                        "usage": {"input_tokens": usage.0, "output_tokens": usage.1}
                                    }),
                                ),
                                AnthropicScript::ToolUse { id, name, input, usage } => (
                                    200,
                                    json!({
                                        "id": "msg_test",
                                        "type": "message",
                                        "role": "assistant",
                                        "model": "claude-test",
                                        "content": [{
                                            "type": "tool_use",
                                            "id": id,
                                            "name": name,
                                            "input": input
                                        }],
                                        "stop_reason": "tool_use",
                                        "usage": {"input_tokens": usage.0, "output_tokens": usage.1}
                                    }),
                                ),
                                AnthropicScript::HttpError { status, body } => {
                                    (status, Value::String(body))
                                }
                            };
                            write_json(&mut stream, status, &payload).await;
                        });
                    }
                }
            }
        });
        Self {
            base_url,
            requests,
            _shutdown: shutdown_tx,
            _task: task,
        }
    }
}

async fn read_http_body(stream: &mut tokio::net::TcpStream) -> Option<(String, String)> {
    let mut buf = vec![0u8; 65536];
    let mut collected = Vec::new();
    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return None,
        };
        collected.extend_from_slice(&buf[..n]);
        if collected.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let raw = String::from_utf8_lossy(&collected);
    let (headers, body) = raw.split_once("\r\n\r\n")?;
    let mut body = body.to_owned();
    if let Some(len) = headers.lines().find_map(|l| {
        l.split_once(':').and_then(|(k, v)| {
            (k.eq_ignore_ascii_case("content-length"))
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        })
    }) {
        while body.len() < len {
            let n = match stream.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => return None,
            };
            body.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        body.truncate(len);
    }
    Some((headers.to_owned(), body))
}

async fn write_json(stream: &mut tokio::net::TcpStream, status: u16, payload: &Value) {
    let body = match payload {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
    };
    let reason = if status == 200 { "OK" } else { "ERR" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}
