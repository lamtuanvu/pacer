use crate::{PluginError, wire};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, mpsc, oneshot};

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
}

fn unavailable() -> PluginError {
    PluginError::new("plugin_unavailable", "host closed the connection")
}

impl Host {
    pub(crate) fn new(out: mpsc::UnboundedSender<String>) -> Self {
        Self {
            out,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: Arc::new(AtomicU64::new(1)),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        let (tx, rx) = oneshot::channel();
        let id = format!("p{}", self.next.fetch_add(1, Ordering::Relaxed));
        {
            let mut pending = self.pending.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            pending.insert(id.clone(), tx);
            if self.out.send(wire::request(&id, method, params)).is_err() {
                pending.remove(&id);
                return Err(unavailable());
            }
        }
        rx.await.unwrap_or_else(|_| Err(unavailable()))
    }

    pub async fn log(&self, level: &str, message: &str) -> Result<(), PluginError> {
        self.call(
            "capability.log",
            json!({ "level": level, "message": message }),
        )
        .await?;
        Ok(())
    }

    pub async fn config(&self) -> Result<Map<String, Value>, PluginError> {
        let result = self.call("capability.config.get", json!({})).await?;
        Ok(result
            .get("config")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default())
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
                json!({ "purpose": purpose, "payload": base64::encode(payload) }),
            )
            .await?;
        let invalid =
            || PluginError::new("internal", "host returned an invalid identity.sign result");
        let signature = result
            .get("signature")
            .and_then(Value::as_str)
            .and_then(base64::decode)
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

    pub(crate) async fn respond(&self, id: String, result: Result<Value, wire::WireError>) {
        if let Some(tx) = self.pending.lock().await.remove(&id) {
            let _ = tx.send(result.map_err(|e| PluginError {
                code: e.code().to_owned(),
                hint: e.hint().map(str::to_owned),
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

/// Standard padded base64, as the plugin protocol carries bytes.
mod base64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b = [
                chunk.first().copied().unwrap_or(0),
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    /// Canonical padded base64 only; anything else is None.
    pub fn decode(text: &str) -> Option<Vec<u8>> {
        if !text.len().is_multiple_of(4) {
            return None;
        }
        let pad = text.bytes().rev().take_while(|&c| c == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut bits: u32 = 0;
        let mut count = 0;
        let mut out = Vec::with_capacity(text.len() / 4 * 3);
        for c in text.bytes().take(text.len() - pad) {
            let v = ALPHABET.iter().position(|&a| a == c)?;
            bits = (bits << 6) | v as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
        }
        (bits == 0).then_some(out)
    }
}
