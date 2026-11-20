//! In-process openai-compatible `/v1/chat/completions` for plugin tests.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub body: Value,
    pub authorization: Option<String>,
}

#[derive(Clone)]
pub enum ScriptedReply {
    /// A plain assistant text message.
    Text {
        content: String,
        usage: (u64, u64),
    },
    /// An assistant message that only requests tool calls.
    ToolCalls {
        calls: Vec<(String, String, Value)>,
        usage: (u64, u64),
    },
    /// Hold the connection open until cancelled or the test drops the server.
    Hang,
}

pub struct FakeOpenAi {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<RecordedRequest>>>,
    _shutdown: oneshot::Sender<()>,
    _task: JoinHandle<()>,
}

impl FakeOpenAi {
    pub async fn start(mut script: VecDeque<ScriptedReply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}/v1");
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
                        let reply = script.pop_front().unwrap_or(ScriptedReply::Text {
                            content: "fallback".into(),
                            usage: (1, 1),
                        });
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 65536];
                            let mut collected = Vec::new();
                            loop {
                                let n = match stream.read(&mut buf).await {
                                    Ok(0) => break,
                                    Ok(n) => n,
                                    Err(_) => return,
                                };
                                collected.extend_from_slice(&buf[..n]);
                                if collected.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            let raw = String::from_utf8_lossy(&collected);
                            let (headers, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
                            // Content-Length body may still be incomplete if it arrived later.
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
                                        Err(_) => return,
                                    };
                                    body.push_str(&String::from_utf8_lossy(&buf[..n]));
                                }
                                body.truncate(len);
                            }
                            let authorization = headers.lines().find_map(|l| {
                                l.split_once(':').and_then(|(k, v)| {
                                    k.eq_ignore_ascii_case("authorization")
                                        .then(|| v.trim().to_owned())
                                })
                            });
                            let parsed: Value =
                                serde_json::from_str(&body).unwrap_or(Value::Null);
                            reqs.lock().unwrap().push(RecordedRequest {
                                body: parsed,
                                authorization,
                            });
                            match reply {
                                ScriptedReply::Hang => {
                                    // Keep the socket open until the peer drops it.
                                    let mut sink = [0u8; 64];
                                    let _ = stream.read(&mut sink).await;
                                }
                                other => {
                                    let payload = match other {
                                        ScriptedReply::Text { content, usage } => json!({
                                            "id": "chatcmpl-test",
                                            "object": "chat.completion",
                                            "created": 1,
                                            "model": "test-model",
                                            "choices": [{
                                                "index": 0,
                                                "message": { "role": "assistant", "content": content },
                                                "finish_reason": "stop"
                                            }],
                                            "usage": {
                                                "prompt_tokens": usage.0,
                                                "completion_tokens": usage.1,
                                                "total_tokens": usage.0 + usage.1
                                            }
                                        }),
                                        ScriptedReply::ToolCalls { calls, usage } => {
                                            let tool_calls: Vec<Value> = calls
                                                .into_iter()
                                                .enumerate()
                                                .map(|(i, (id, name, args))| {
                                                    json!({
                                                        "id": id,
                                                        "type": "function",
                                                        "function": {
                                                            "name": name,
                                                            "arguments": args.to_string()
                                                        },
                                                        "index": i
                                                    })
                                                })
                                                .collect();
                                            json!({
                                                "id": "chatcmpl-test",
                                                "object": "chat.completion",
                                                "created": 1,
                                                "model": "test-model",
                                                "choices": [{
                                                    "index": 0,
                                                    "message": {
                                                        "role": "assistant",
                                                        "content": "",
                                                        "tool_calls": tool_calls
                                                    },
                                                    "finish_reason": "tool_calls"
                                                }],
                                                "usage": {
                                                    "prompt_tokens": usage.0,
                                                    "completion_tokens": usage.1,
                                                    "total_tokens": usage.0 + usage.1
                                                }
                                            })
                                        }
                                        ScriptedReply::Hang => unreachable!(),
                                    };
                                    let body = payload.to_string();
                                    let resp = format!(
                                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                                        body.len(),
                                        body
                                    );
                                    let _ = stream.write_all(resp.as_bytes()).await;
                                    let _ = stream.shutdown().await;
                                }
                            }
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

    pub fn tool_names_offered(&self) -> Vec<Vec<String>> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                r.body
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|tools| {
                        tools
                            .iter()
                            .filter_map(|t| {
                                t.pointer("/function/name")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect()
    }
}
