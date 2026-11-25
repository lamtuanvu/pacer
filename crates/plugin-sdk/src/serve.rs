use crate::{Host, PluginError, chunk, js, stream, wire};
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

#[derive(Clone)]
pub struct Ctx {
    pub host: Host,
    pub cancel: CancellationToken,
    pub progress: Progress,
    pub(crate) state: Arc<RwLock<FeatureState>>,
    pub(crate) owned: Option<OwnedSlot>,
}

/// The owned-stream authority a `hostRunner.stream` request carries: the
/// numeric request id, the string params.streamId, the per-call host and the
/// shared registry of input slots.
#[derive(Clone)]
pub(crate) struct OwnedSlot {
    pub request_id: u64,
    pub stream_id: String,
    pub host: Host,
    pub cancel: CancellationToken,
    pub streams: stream::Streams,
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

    /// An owned duplex stream handle, `Some` only for a `hostRunner.stream`
    /// request with a numeric id, a string `params.streamId` and a string
    /// `_meta.capabilityCall` (index.ts:296-300).
    pub fn owned_stream(&self) -> Option<stream::OwnedStream> {
        self.owned.as_ref().map(|o| stream::OwnedStream {
            request_id: o.request_id,
            stream_id: o.stream_id.clone(),
            host: o.host.clone(),
            cancel: o.cancel.clone(),
            streams: o.streams.clone(),
        })
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

    /// Typed `workflow.definitions` handler (host ≥ 1.12.0). At most one workflow per page.
    pub fn workflow_definitions<F, Fut>(self, f: F) -> Self
    where
        F: Fn(crate::types::WorkflowDefinitionsParams, Ctx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<crate::types::WorkflowDefinitionsResult, PluginError>>
            + Send
            + 'static,
    {
        self.handle_typed("workflow.definitions", f)
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
        let host = Host::new(out.clone(), self.state.clone());
        let inflight = Arc::new(Mutex::new(HashMap::<String, CancellationToken>::new()));
        let streams = stream::Streams::default();
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
                Some(wire::Incoming::Notification { method, params }) if method == "$/streamInput" => {
                    let Some(request) = params.get("request").and_then(Value::as_u64) else {
                        continue;
                    };
                    let slot = {
                        let slots = streams.lock();
                        match slots.get(&request) {
                            Some(s) => s.clone(),
                            None => continue,
                        }
                    };
                    // Base64 must be canonical and round-trip (index.ts's regex
                    // plus `Buffer.from` re-encode check).
                    let encoded = params.get("base64").and_then(Value::as_str).unwrap_or_default();
                    let decoded = js::base64::decode_lenient(encoded);
                    let bytes_ok = !decoded.is_empty()
                        && decoded.len() <= 65_536
                        && js::base64::encode(&decoded) == encoded;
                    // Read the slot's expected state, install the delivered frame,
                    // and take any pending waiter while holding the lock once, so a
                    // waiting `next_input` is woken only after the frame is present.
                    let (valid, waiter) = {
                        let mut st = stream::lock(&slot);
                        let valid = params.get("streamId").and_then(Value::as_str)
                            == Some(&*st.stream_id)
                            && params.get("seq").and_then(Value::as_u64) == Some(st.next_seq)
                            && st.frame.is_none()
                            && params.as_object().map(|o| o.len() == 4).unwrap_or(false);
                        if valid {
                            st.frame = Some(stream::OwnedFrame {
                                seq: st.next_seq,
                                bytes: decoded.clone(),
                                delivered: false,
                            });
                        }
                        (valid, st.waiter.take())
                    };
                    if !valid || !bytes_ok {
                        if let Some(token) = inflight.lock().await.get(&request.to_string()) {
                            token.cancel();
                        }
                        if let Some(w) = waiter {
                            let _ = w.send(Err(PluginError::new(
                                "plugin_refused",
                                "invalid stream input frame",
                            )));
                        }
                        continue;
                    }
                    if let Some(w) = waiter {
                        let _ = w.send(Ok(()));
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
                        let offered: Vec<String> = params
                            .get("features")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect();
                        let mut fs = state.write().unwrap_or_else(|e| e.into_inner());
                        fs.offered = offered.iter().cloned().collect();
                        fs.major = protocol.major;
                        fs.minor = protocol.minor;
                        fs.negotiated.clear();
                        // Negotiate only what this plugin requested (.features) that the
                        // host also offered and the protocol permits, echoing in the
                        // host's offer order exactly as the TypeScript SDK filters
                        // hello.features (index.ts:281-289): major 1 only, gated by the
                        // protocol minor.
                        let mut echoed: Vec<Value> = Vec::new();
                        if protocol.major == 1 {
                            for f in &offered {
                                if self.features.iter().any(|w| w == f)
                                    && gate_minor(f, protocol.minor)
                                {
                                    fs.negotiated.insert(f.clone());
                                    echoed.push(json!(f));
                                }
                            }
                        }
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
                    // Own a duplex stream when the request is a `hostRunner.stream`
                    // with a numeric id, a string params.streamId and a string
                    // _meta.capabilityCall (index.ts:296-300). The owner pulls
                    // input via `$/streamInput` and its duplex calls get the
                    // stream deadlines (index.ts:81-90).
                    let stream_owner = if method == "hostRunner.stream"
                        && let Some(request_id) = id.as_u64()
                        && let Some(stream_id) = params.get("streamId").and_then(Value::as_str)
                        && wire::capability_call_token(meta.as_ref()).is_some()
                    {
                        Some((request_id, stream_id.to_owned()))
                    } else {
                        None
                    };
                    let call_host = host.for_call(
                        wire::capability_call_token(meta.as_ref()),
                        cancel.clone(),
                        stream_owner.is_some(),
                    );
                    let owned = stream_owner.map(|(request_id, stream_id)| {
                        let mut slots = streams.lock();
                        slots.insert(
                            request_id,
                            Arc::new(std::sync::Mutex::new(stream::StreamInputState {
                                stream_id: stream_id.clone(),
                                next_seq: 0,
                                frame: None,
                                waiter: None,
                            })),
                        );
                        drop(slots);
                        OwnedSlot {
                            request_id,
                            stream_id,
                            host: call_host.clone(),
                            cancel: cancel.clone(),
                            streams: streams.clone(),
                        }
                    });
                    // Stream owners must tear their input slot down once the handler
                    // returns: reject any still-waiting `next_input` and remove the
                    // slot so a late `$/streamInput` for a dead owner is dropped.
                    let cleanup_stream = owned.as_ref().map(|o| (o.request_id, o.streams.clone()));
                    let ctx = Ctx {
                        host: call_host.clone(),
                        cancel: cancel.clone(),
                        progress: Progress {
                            id: id.clone(),
                            out: out.clone(),
                        },
                        state: state.clone(),
                        owned,
                    };
                    let out = out.clone();
                    let inflight = inflight.clone();
                    let policy_host = call_host;
                    let state_for_policy = state.clone();
                    let method_for_chunk = method.clone();
                    let id_for_chunk = id.clone();
                    let cancel_for_chunk = cancel.clone();
                    tasks.spawn(async move {
                        let result = match handler {
                            Some(handler) => handler(params.clone(), ctx).await,
                            None => {
                                Ok(json!({"ok":true, "uptimeS":started.elapsed().as_secs_f64()}))
                            }
                        };
                        let policy = state_for_policy
                            .read()
                            .map(|g| chunk::ChunkPolicy {
                                major: g.major,
                                minor: g.minor,
                                chunk_offered: g.offered.contains("chunkedResults"),
                                planner_transactions: g
                                    .negotiated
                                    .contains("plannerInstallTransactions"),
                            })
                            .unwrap_or_default();
                        let scoped = method_for_chunk == "usage.read"
                            || meta
                                .as_ref()
                                .and_then(|m| m.get("capabilityCall"))
                                .is_some();
                        let line = match result {
                            Ok(value) => {
                                chunk::finish(
                                    value,
                                    &id_for_chunk,
                                    &method_for_chunk,
                                    scoped,
                                    policy,
                                    &policy_host,
                                    &cancel_for_chunk,
                                )
                                .await
                            }
                            Err(e) => wire::error(&id, -32000, &e.message, e.data()),
                        };
                        let _ = out.send(line);
                        if let Some((request_id, streams)) = cleanup_stream {
                            let mut slots = streams.lock();
                            if let Some(slot) = slots.remove(&request_id) {
                                let mut st = stream::lock(&slot);
                                if let Some(w) = st.waiter.take() {
                                    let _ = w.send(Err(PluginError::new(
                                        "plugin_unavailable",
                                        "stream input owner ended",
                                    )));
                                }
                            }
                        }
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
