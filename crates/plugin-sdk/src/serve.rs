use crate::{Host, PluginError, js, wire};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock},
    time::Instant,
};
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

/// Negotiated features and the protocol minor from `plugin.hello`.
#[derive(Default)]
pub(crate) struct FeatureState {
    pub negotiated: HashSet<String>,
    pub offered: HashSet<String>,
    pub major: i64,
    pub minor: i64,
}

pub struct Ctx {
    pub host: Host,
    pub cancel: CancellationToken,
    pub progress: Progress,
    pub(crate) state: Arc<RwLock<FeatureState>>,
}

impl Ctx {
    /// Whether `feature` was successfully negotiated with the host at hello
    /// (index.ts:171). Guards chunked fs writes, http bodies, policy transport.
    pub fn negotiated(&self, feature: &str) -> bool {
        match self.state.read() {
            Ok(g) => g.negotiated.contains(feature),
            Err(e) => e.into_inner().negotiated.contains(feature),
        }
    }
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

    /// Send a plugin → host notification (for example `assistant.delta`).
    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.out.send(wire::notification(method, params));
    }
}

/// The minimum protocol minor at which each feature can be negotiated
/// (packages/plugin-sdk/src/index.ts:282-287).
fn gate_minor(feature: &str, minor: i64) -> bool {
    match feature {
        "chunkedResults" => minor >= 1,
        "httpBodyChunks" => minor >= 2,
        "fileWriteChunks" => minor >= 4,
        "plannerInstallTransactions" => minor >= 4,
        "policyObservations" => minor >= 6,
        "policyRedactionMetadata" => minor >= 8,
        _ => false,
    }
}

struct Protocol {
    major: i64,
    minor: i64,
}

fn parse_protocol(value: Option<&Value>) -> Protocol {
    let parts: Vec<i64> = value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split('.')
        .filter_map(|s| s.parse::<i64>().ok())
        .collect();
    Protocol {
        major: parts.first().copied().unwrap_or(0),
        minor: parts.get(1).copied().unwrap_or(0),
    }
}

/// Canonical string for a JSON `id` (number or string), so an owner's
/// `$/cancel` matches the request it refers to regardless of whether the id
/// arrived as a number or a string (index.ts). `Value::to_string` would
/// JSON-quote string ids, so never use it for id-keyed lookups.
fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub struct Plugin {
    manifest: Manifest,
    contributes: Option<Vec<String>>,
    handlers: HashMap<String, Handler>,
    features: Vec<String>,
    state: Arc<RwLock<FeatureState>>,
}

impl Plugin {
    pub fn new(manifest: Manifest) -> Self {
        Self {
            manifest,
            contributes: None,
            handlers: HashMap::new(),
            features: Vec::new(),
            state: Arc::new(RwLock::new(FeatureState::default())),
        }
    }

    pub fn contributes(mut self, points: Vec<String>) -> Self {
        self.contributes = Some(points);
        self
    }

    /// Declare the features this plugin wants to negotiate with the host. Only
    /// ones the host also offers and that the protocol minor permits are echoed.
    pub fn features(mut self, features: Vec<&str>) -> Self {
        self.features = features.into_iter().map(String::from).collect();
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
        let state = self.state.clone();
        let read_result = loop {
            let line = tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => line,
                    Ok(None) => break Ok(()),
                    Err(e) => break Err(e),
                },
                result = &mut writer => {
                    writer_done = true;
                    break result.map_err(std::io::Error::other).and_then(|r| r);
                },
                Some(_) = tasks.join_next(), if !tasks.is_empty() => continue,
            };
            match wire::parse(&line) {
                Some(wire::Incoming::Response { id, result }) => host.respond(id, result).await,
                Some(wire::Incoming::Notification { method, params }) if method == "$/cancel" => {
                    if let Some(key) = params.get("id").and_then(id_key)
                        && let Some(token) = inflight.lock().await.get(&key)
                    {
                        token.cancel();
                    }
                }
                Some(wire::Incoming::Request {
                    id,
                    method,
                    params,
                    meta,
                }) => {
                    if method == "plugin.hello" {
                        started = Some(Instant::now());
                        let protocol = parse_protocol(params.get("protocol"));
                        let offered: HashSet<String> = params
                            .get("features")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect();
                        let mut fs = state.write().unwrap_or_else(|e| e.into_inner());
                        fs.offered = offered.clone();
                        fs.major = protocol.major;
                        fs.minor = protocol.minor;
                        fs.negotiated.clear();
                        for f in &self.features {
                            if offered.contains(f) && gate_minor(f, protocol.minor) {
                                fs.negotiated.insert(f.clone());
                            }
                        }
                        let echoed: Vec<Value> = fs.negotiated.iter().map(|f| json!(f)).collect();
                        drop(fs);
                        let mut result = json!({
                            "protocol": pacer_plugin_protocol::VERSION,
                            "id": self.manifest.id(), "version": self.manifest.version(),
                            "contributes": self.contributes.clone().unwrap_or_else(|| self.manifest.contributes_keys())
                        });
                        if !echoed.is_empty() {
                            result["features"] = Value::Array(echoed);
                        }
                        let _ = out.send(wire::result(&id, result));
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
                    let key = id_key(&id).unwrap_or_else(|| id.to_string());
                    inflight.lock().await.insert(key.clone(), cancel.clone());
                    let call_host =
                        host.for_call(wire::capability_call_token(meta.as_ref()), cancel.clone());
                    let ctx = Ctx {
                        host: call_host.clone(),
                        cancel: cancel.clone(),
                        progress: Progress {
                            id: id.clone(),
                            out: out.clone(),
                        },
                        state: state.clone(),
                    };
                    let out = out.clone();
                    let inflight = inflight.clone();
                    let chunk_host = call_host;
                    let state_for_len = state.clone();
                    let is_numeric_id = id.is_number();
                    let method_for_chunk = method.clone();
                    tasks.spawn(async move {
                        let result = match handler {
                            Some(handler) => handler(params.clone(), ctx).await,
                            None => {
                                Ok(json!({"ok":true, "uptimeS":started.elapsed().as_secs_f64()}))
                            }
                        };
                        let line = match result {
                            Ok(value) => {
                                let scoped = method == "usage.read"
                                    || meta.as_ref().and_then(|m| m.get("capabilityCall")).is_some();
                                if scoped && cancel.is_cancelled() {
                                    wire::error(
                                        &id,
                                        -32000,
                                        "owning plugin call ended",
                                        json!({"code":"plugin_unavailable"}),
                                    )
                                } else {
                                    let fs = state_for_len
                                        .read()
                                        .map(|g| (g.major, g.minor,
                                            g.offered.contains("chunkedResults"),
                                            g.negotiated.contains("plannerInstallTransactions")))
                                        .unwrap_or((0, 0, false, false));
                                    let (major, minor, chunk_offered, planner) = fs;
                                    let chunked = (method_for_chunk == "usage.read"
                                        || (method_for_chunk == "planner.install"
                                            || method_for_chunk == "planner.uninstall")
                                            && planner)
                                        && is_numeric_id
                                        && major == 1
                                        && minor >= 1
                                        && chunk_offered;
                                    let bytes = if chunked {
                                        serde_json::to_vec(&value).unwrap_or_default()
                                    } else {
                                        Vec::new()
                                    };
                                    if chunked && bytes.len() > 768 * 1024 {
                                        let mut offset = 0usize;
                                        let mut failure: Option<(String, String)> = None;
                                        while offset < bytes.len() {
                                            if cancel.is_cancelled() {
                                                failure = Some((
                                                    "plugin_unavailable".into(),
                                                    "owning plugin call ended".into(),
                                                ));
                                                break;
                                            }
                                            let end = (offset + 262144).min(bytes.len());
                                            let ack = chunk_host
                                                .call(
                                                    "$/resultChunk",
                                                    json!({"request": id, "offset": offset,
                                                        "base64": js::base64::encode(&bytes[offset..end])}),
                                                )
                                                .await;
                                            match ack {
                                                Ok(a) if a.get("bytes")
                                                    .and_then(Value::as_u64)
                                                    .is_some_and(|b| b as usize == offset + (end - offset)) => {
                                                    offset = end;
                                                }
                                                Ok(_) => {
                                                    failure = Some((
                                                        "plugin_refused".into(),
                                                        "incomplete result chunk acknowledgement".into(),
                                                    ));
                                                    break;
                                                }
                                                Err(e) => {
                                                    failure = Some((e.code.clone(), e.message.clone()));
                                                    break;
                                                }
                                            }
                                        }
                                        match failure {
                                            Some((code, message)) => wire::error(
                                                &id,
                                                -32000,
                                                &message,
                                                json!({"code": code}),
                                            ),
                                            None => {
                                                if cancel.is_cancelled() {
                                                    wire::error(
                                                        &id,
                                                        -32000,
                                                        "owning plugin call ended",
                                                        json!({"code":"plugin_unavailable"}),
                                                    )
                                                } else {
                                                    wire::result(
                                                        &id,
                                                        json!({"_chunkedResult": {"bytes": bytes.len()}}),
                                                    )
                                                }
                                            }
                                        }
                                    } else {
                                        wire::result(&id, value)
                                    }
                                }
                            }
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
