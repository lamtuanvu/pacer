use crate::{PluginError, js, serve, wire};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// The result of [`Host::identity_sign`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineSignature {
    /// The raw ed25519 signature.
    pub signature: Vec<u8>,
    /// The signing machine's id (base32 public key).
    pub machine_id: String,
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, PluginError>>>;

#[derive(Clone)]
pub struct Host {
    out: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<Pending>>,
    next: Arc<AtomicU64>,
    closed: Arc<AtomicBool>,
    /// Token from the owning host call's `_meta.capabilityCall`, echoed on capability requests.
    pub(crate) capability_call: Option<String>,
    /// The owning host call's cancellation token. When it fires, every call made
    /// by this owner rejects with "owning plugin call ended" (index.ts:131-158).
    pub(crate) cancel: Option<CancellationToken>,
    /// Serialises `capability.net.http` transactions so only one runs at a time
    /// per caller (index.ts: http latch).
    pub(crate) queue: Arc<Mutex<()>>,
    /// Serialises `capability.fs.*` transactions so only one runs at a time
    /// per caller (index.ts: createFileSystem tail). Created fresh per call so
    /// concurrent owning calls each have their own queue, as the TS `hostFor`
    /// builds a fresh `createFileSystem` per request.
    pub(crate) fs_queue: Arc<Mutex<()>>,
    /// Negotiated features and protocol of the owning plugin, so `Host::http`
    /// can test whether `httpBodyChunks` was negotiated.
    pub(crate) state: Arc<RwLock<serve::FeatureState>>,
    /// The per-frame limit in bytes for `Host::fits`, overridable for tests.
    pub(crate) frame_limit: Arc<AtomicUsize>,
    /// Whether this host belongs to a `hostRunner.stream` owner, which applies
    /// the duplex deadlines (packages/plugin-sdk/src/index.ts:81-90).
    pub(crate) owner_is_stream: bool,
}

fn unavailable() -> PluginError {
    PluginError::new("plugin_unavailable", "host closed the connection")
}

pub(crate) fn owning_ended() -> PluginError {
    PluginError::new("plugin_unavailable", "owning plugin call ended")
}

impl Host {
    pub(crate) fn new(
        out: mpsc::UnboundedSender<String>,
        state: Arc<RwLock<serve::FeatureState>>,
    ) -> Self {
        Self {
            out,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: Arc::new(AtomicU64::new(1)),
            closed: Arc::new(AtomicBool::new(false)),
            capability_call: None,
            cancel: None,
            queue: Arc::new(Mutex::new(())),
            fs_queue: Arc::new(Mutex::new(())),
            state,
            frame_limit: Arc::new(AtomicUsize::new(1048576)),
            owner_is_stream: false,
        }
    }

    /// Host scoped to one inbound plugin call, echoing that call's capability
    /// token and carrying its cancellation token. `owner_is_stream` marks a
    /// `hostRunner.stream` owner so duplex calls get the stream deadlines.
    pub(crate) fn for_call(
        &self,
        capability_call: Option<String>,
        cancel: CancellationToken,
        owner_is_stream: bool,
    ) -> Self {
        Self {
            out: self.out.clone(),
            pending: self.pending.clone(),
            next: self.next.clone(),
            closed: self.closed.clone(),
            capability_call,
            cancel: Some(cancel),
            queue: self.queue.clone(),
            fs_queue: Arc::new(Mutex::new(())),
            state: self.state.clone(),
            frame_limit: self.frame_limit.clone(),
            owner_is_stream,
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        self.call_inner(method, params, true).await
    }

    /// Make a capability call that ignores the owning call's cancellation
    /// (matches the TypeScript `cleanupCall`, e.g. for `fs.write`).
    pub async fn call_cleanup(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        self.call_inner(method, params, false).await
    }

    /// The duplex deadline for a stream-owned call (index.ts:81-90): open is
    /// fixed at 10 s, close at 5 s, and read/write at `min(timeoutMs+5000, 65000)`.
    fn duplex_deadline(&self, method: &str, params: &Value) -> Option<std::time::Duration> {
        if !self.owner_is_stream {
            return None;
        }
        let ms = match method {
            "capability.process.duplex.open" => 10_000,
            "capability.process.duplex.close" => 5_000,
            "capability.process.duplex.read" | "capability.process.duplex.write" => {
                let requested = params
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .filter(|v| *v > 0);
                requested.map_or(65_000, |v| (v + 5_000).min(65_000))
            }
            _ => return None,
        };
        Some(std::time::Duration::from_millis(ms as u64))
    }

    async fn call_inner(
        &self,
        method: &str,
        params: Value,
        honour_cancel: bool,
    ) -> Result<Value, PluginError> {
        if honour_cancel && self.cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            return Err(owning_ended());
        }
        let (tx, rx) = oneshot::channel();
        let id = format!("p{}", self.next.fetch_add(1, Ordering::Relaxed));
        let deadline = self.duplex_deadline(method, &params);
        let meta = self
            .capability_call
            .as_ref()
            .map(|token| json!({ "capabilityCall": token }));
        {
            let mut pending = self.pending.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            pending.insert(id.clone(), tx);
            if self
                .out
                .send(wire::request_with_meta(&id, method, params, meta.as_ref()))
                .is_err()
            {
                pending.remove(&id);
                return Err(unavailable());
            }
        }
        if honour_cancel && let Some(token) = &self.cancel {
            if token.is_cancelled() {
                self.pending.lock().await.remove(&id);
                return Err(owning_ended());
            }
            let pending = self.pending.clone();
            let id = id.clone();
            let token = token.clone();
            tokio::spawn(async move {
                token.cancelled().await;
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let _ = tx.send(Err(owning_ended()));
                }
            });
        }
        let mut rx = rx;
        if let Some(deadline) = deadline {
            match tokio::time::timeout(deadline, &mut rx).await {
                Ok(Ok(result)) => Ok(result?),
                Ok(Err(_)) => Err(unavailable()),
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    Err(PluginError::new(
                        "plugin_timeout",
                        format!(
                            "{method} response passed its {} ms deadline",
                            deadline.as_millis()
                        ),
                    ))
                }
            }
        } else {
            rx.await.unwrap_or_else(|_| Err(unavailable()))
        }
    }

    pub async fn log(&self, level: &str, message: &str) -> Result<(), PluginError> {
        self.call(
            "capability.log",
            json!({ "level": level, "message": message }),
        )
        .await?;
        Ok(())
    }

    /// Send a plugin → host notification (for example `$/progress` for an
    /// owned stream) without waiting for a reply.
    pub(crate) fn emit(&self, method: &str, params: Value) {
        let _ = self.out.send(wire::notification(method, params));
    }

    pub async fn config(&self) -> Result<Map<String, Value>, PluginError> {
        let result = self.call("capability.config.get", json!({})).await?;
        Ok(result
            .get("config")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default())
    }

    /// Whether a secret reference is present (host >= 1.4.0), via
    /// `capability.secrets.check {ref}` (index.ts:224).
    pub async fn secrets_present(&self, reference: &str) -> Result<bool, PluginError> {
        let result = self
            .call("capability.secrets.check", json!({ "ref": reference }))
            .await?;
        Ok(result
            .get("present")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    /// Sign `payload` with the machine key for a purpose declared in the manifest's `identity.sign` scopes.
    /// The host signs `"pacer-machine-sig/v1" 0x00 plugin_id 0x00 purpose 0x00 payload`, never the raw payload.
    pub async fn identity_sign(
        &self,
        purpose: &str,
        payload: &[u8],
    ) -> Result<MachineSignature, PluginError> {
        let result = self
            .call(
                "capability.identity.sign",
                json!({ "purpose": purpose, "payload": js::base64::encode(payload) }),
            )
            .await?;
        let invalid =
            || PluginError::new("internal", "host returned an invalid identity.sign result");
        let signature = result
            .get("signature")
            .and_then(Value::as_str)
            .and_then(js::base64::decode)
            .ok_or_else(invalid)?;
        let machine_id = result
            .get("machineId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .to_owned();
        Ok(MachineSignature {
            signature,
            machine_id,
        })
    }

    pub(crate) fn next_id(&self) -> u64 {
        self.next.load(Ordering::Relaxed)
    }

    pub(crate) async fn respond(&self, id: String, result: Result<Value, wire::WireError>) {
        if let Some(tx) = self.pending.lock().await.remove(&id) {
            let _ = tx.send(result.map_err(|e| PluginError {
                code: e.code().to_owned(),
                hint: e.hint().map(str::to_owned),
                reason: e.reason().map(str::to_owned),
                message: e.message,
            }));
        }
    }

    pub(crate) async fn close(&self) {
        let mut pending = self.pending.lock().await;
        self.closed.store(true, Ordering::Release);
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(unavailable()));
        }
    }
}
