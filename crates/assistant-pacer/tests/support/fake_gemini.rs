//! In-process Gemini `:generateContent` for plugin tests.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct RecordedGeminiRequest {
    #[allow(dead_code)]
    pub path: String,
    pub body: Value,
    pub api_key: Option<String>,
}

#[derive(Clone)]
pub enum GeminiScript {
    Text {
        content: String,
        usage: (u64, u64),
    },
    FunctionCall {
        name: String,
        args: Value,
        usage: (u64, u64),
    },
    HttpError {
        status: u16,
        body: String,
    },
}

pub struct FakeGemini {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<RecordedGeminiRequest>>>,
    _shutdown: oneshot::Sender<()>,
    _task: JoinHandle<()>,
}

impl FakeGemini {
    pub async fn start(mut script: VecDeque<GeminiScript>) -> Self {
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
                        let reply = script.pop_front().unwrap_or(GeminiScript::Text {
                            content: "fallback".into(),
                            usage: (1, 1),
                        });
                        tokio::spawn(async move {
                            let body = read_http_body(&mut stream).await;
                            let Some((request_line, headers, body)) = body else { return };
                            let path = request_line.split_whitespace().nth(1).unwrap_or("").to_owned();
                            let api_key = path
                                .split('?')
                                .nth(1)
                                .and_then(|q| {
                                    q.split('&').find_map(|pair| {
                                        let (k, v) = pair.split_once('=')?;
                                        (k == "key").then(|| v.to_owned())
                                    })
                                })
                                .or_else(|| {
                                    headers.lines().find_map(|l| {
                                        l.split_once(':').and_then(|(k, v)| {
                                            k.eq_ignore_ascii_case("x-goog-api-key")
                                                .then(|| v.trim().to_owned())
                                        })
                                    })
                                });
                            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                            let max_out = parsed
                                .pointer("/generationConfig/maxOutputTokens")
                                .and_then(Value::as_u64);
                            assert!(
                                max_out.is_some(),
                                "gemini body must include generationConfig.maxOutputTokens, got {parsed}"
                            );
                            reqs.lock().unwrap().push(RecordedGeminiRequest {
                                path,
                                body: parsed,
                                api_key,
                            });
                            let (status, payload) = match reply {
                                GeminiScript::Text { content, usage } => (
                                    200u16,
                                    json!({
                                        "responseId": "resp_test",
                                        "candidates": [{
                                            "content": {
                                                "role": "model",
                                                "parts": [{"text": content}]
                                            },
                                            "finishReason": "STOP"
                                        }],
                                        "usageMetadata": {
                                            "promptTokenCount": usage.0,
                                            "candidatesTokenCount": usage.1,
                                            "totalTokenCount": usage.0 + usage.1
                                        }
                                    }),
                                ),
                                GeminiScript::FunctionCall { name, args, usage } => (
                                    200,
                                    json!({
                                        "responseId": "resp_test",
                                        "candidates": [{
                                            "content": {
                                                "role": "model",
                                                "parts": [{"functionCall": {"name": name, "args": args}}]
                                            },
                                            "finishReason": "STOP"
                                        }],
                                        "usageMetadata": {
                                            "promptTokenCount": usage.0,
                                            "candidatesTokenCount": usage.1,
                                            "totalTokenCount": usage.0 + usage.1
                                        }
                                    }),
                                ),
                                GeminiScript::HttpError { status, body } => {
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

async fn read_http_body(stream: &mut tokio::net::TcpStream) -> Option<(String, String, String)> {
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
    let request_line = headers.lines().next()?.to_owned();
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
    Some((request_line, headers.to_owned(), body))
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
