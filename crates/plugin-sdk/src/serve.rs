use crate::{Host, PluginError, wire};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc, time::Instant};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub struct Manifest(pub Value);

impl Manifest {
    pub fn id(&self) -> &str {
        self.0.get("id").and_then(Value::as_str).unwrap_or_default()
    }

    pub fn version(&self) -> &str {
        self.0
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    pub fn contributes_keys(&self) -> Vec<String> {
        self.0
            .get("contributes")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }
}

pub struct Ctx {
    pub host: Host,
    pub cancel: CancellationToken,
    pub progress: Progress,
}

pub type HandlerResult = Result<Value, PluginError>;
type Handler =
    Arc<dyn Fn(Value, Ctx) -> Pin<Box<dyn Future<Output = HandlerResult> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Progress {
    id: Value,
    out: mpsc::UnboundedSender<String>,
}

impl Progress {
    pub fn send(&self, data: Value) {
        let _ = self.out.send(wire::notification(
            "$/progress",
            json!({"id": self.id, "data": data}),
        ));
    }
}

pub struct Plugin {
    manifest: Manifest,
    contributes: Option<Vec<String>>,
    handlers: HashMap<String, Handler>,
}

impl Plugin {
    pub fn new(manifest: Manifest) -> Self {
        Self {
            manifest,
            contributes: None,
            handlers: HashMap::new(),
        }
    }

    pub fn contributes(mut self, points: Vec<String>) -> Self {
        self.contributes = Some(points);
        self
    }

    pub fn handle<F, Fut>(mut self, method: &str, f: F) -> Self
    where
        F: Fn(Value, Ctx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = HandlerResult> + Send + 'static,
    {
        self.handlers
            .insert(method.to_owned(), Arc::new(move |p, c| Box::pin(f(p, c))));
        self
    }

    pub fn handle_typed<P, R, F, Fut>(self, method: &str, f: F) -> Self
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize,
        F: Fn(P, Ctx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, PluginError>> + Send + 'static,
    {
        let f = Arc::new(f);
        self.handle(method, move |params, ctx| {
            let f = f.clone();
            async move {
                let params = serde_json::from_value(params)
                    .map_err(|e| PluginError::new("invalid_input", e.to_string()))?;
                serde_json::to_value(f(params, ctx).await?)
                    .map_err(|e| PluginError::new("internal", e.to_string()))
            }
        })
    }

    pub async fn serve<R, W>(self, input: R, mut output: W) -> std::io::Result<()>
    where
        R: AsyncBufRead + Unpin,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out, mut rx) = mpsc::unbounded_channel::<String>();
        let mut writer = tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                output.write_all(line.as_bytes()).await?;
                output.flush().await?;
            }
            Ok::<_, std::io::Error>(())
        });
        let host = Host::new(out.clone());
        let inflight = Arc::new(Mutex::new(HashMap::<String, CancellationToken>::new()));
        let mut tasks = JoinSet::new();
        let mut started = None;
        let mut lines = input.lines();
        let mut writer_done = false;
        let read_result = loop {
            let line = tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => line,
                    Ok(None) => break Ok(()),
                    Err(e) => break Err(e),
                },
                result = &mut writer => {
                    writer_done = true;
                    // A failed writer cannot deliver further replies.
                    break result.map_err(std::io::Error::other).and_then(|r| r);
                },
                Some(_) = tasks.join_next(), if !tasks.is_empty() => continue,
            };
            match wire::parse(&line) {
                Some(wire::Incoming::Response { id, result }) => host.respond(id, result).await,
                Some(wire::Incoming::Notification { method, params }) if method == "$/cancel" => {
                    if let Some(id) = params.get("id")
                        && let Some(token) = inflight.lock().await.get(&id.to_string())
                    {
                        token.cancel();
                    }
                }
                Some(wire::Incoming::Request { id, method, params }) => {
                    if method == "plugin.hello" {
                        started = Some(Instant::now());
                        let _ = out.send(wire::result(&id, json!({
                            "protocol": pacer_plugin_protocol::VERSION,
                            "id": self.manifest.id(), "version": self.manifest.version(),
                            "contributes": self.contributes.clone().unwrap_or_else(|| self.manifest.contributes_keys())
                        })));
                        continue;
                    }
                    let Some(started) = started else {
                        let _ = out.send(wire::error(
                            &id,
                            -32000,
                            "plugin.hello must come first",
                            json!({"code":"plugin_refused"}),
                        ));
                        continue;
                    };
                    let handler = self.handlers.get(&method).cloned();
                    if handler.is_none() && method != "diagnostic.ping" {
                        let _ = out.send(wire::error(
                            &id,
                            -32601,
                            &format!("unknown method {method}"),
                            json!({"code":"unknown_op"}),
                        ));
                        continue;
                    }
                    let cancel = CancellationToken::new();
                    let key = id.to_string();
                    inflight.lock().await.insert(key.clone(), cancel.clone());
                    let ctx = Ctx {
                        host: host.clone(),
                        cancel,
                        progress: Progress {
                            id: id.clone(),
                            out: out.clone(),
                        },
                    };
                    let out = out.clone();
                    let inflight = inflight.clone();
                    tasks.spawn(async move {
                        let result = match handler {
                            Some(handler) => handler(params, ctx).await,
                            None => {
                                Ok(json!({"ok":true, "uptimeS":started.elapsed().as_secs_f64()}))
                            }
                        };
                        let line = match result {
                            Ok(value) => wire::result(&id, value),
                            Err(e) => wire::error(&id, -32000, &e.message, e.data()),
                        };
                        let _ = out.send(line);
                        inflight.lock().await.remove(&key);
                    });
                }
                _ => {}
            }
        };
        host.close().await;
        for token in inflight.lock().await.values() {
            token.cancel();
        }
        while tasks.join_next().await.is_some() {}
        drop(host);
        drop(out);
        let write_result = if writer_done {
            // A completed writer was consumed by the select branch above.
            Ok(())
        } else {
            writer.await.map_err(std::io::Error::other)?
        };
        read_result.and(write_result)
    }

    pub async fn serve_stdio(self) -> std::io::Result<()> {
        self.serve(BufReader::new(tokio::io::stdin()), tokio::io::stdout())
            .await
    }
}
