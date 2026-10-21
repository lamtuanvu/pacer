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
