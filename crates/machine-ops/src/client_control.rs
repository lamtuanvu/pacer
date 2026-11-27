//! The native client control broker (`src/clients/control.ts`), ported verbatim.
//!
//! Workers and their bounded requests live in this process: one `SharedControl` per serve
//! process and one per stdio connection, as each connection previously had its own Core
//! broker. Credentials never leave the API reply; `targets` and `result` hide them.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::{Code, CoreError};
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq;
use std::sync::Arc;
use tokio::sync::Mutex;

const WORKER_LIMIT: usize = 64;
const REQUEST_LIMIT: usize = 256;
const LEASE_MS: f64 = 60_000.0;
const DEADLINE_MS: f64 = 30_000.0;
const PRUNE_MS: f64 = 60_000.0;

struct Worker {
    client_id: String,
    kind: String,
    window: String,
    token: String,
    expires: f64,
}

struct Request {
    request_id: String,
    client_id: String,
    action: Value,
    status: &'static str,
    deadline: f64,
    result: Option<Value>,
    error: Option<String>,
}

/// A page/desktop worker table and its outstanding requests, with an injected clock.
pub struct ClientControl {
    workers: Vec<Worker>,
    requests: Vec<Request>,
    now: Box<dyn Fn() -> f64 + Send>,
}

/// One broker per serve process or stdio connection.
pub type SharedControl = Arc<Mutex<ClientControl>>;

/// A broker driven by the machine clock, in milliseconds as `Date.now` returns.
pub fn shared() -> SharedControl {
    Arc::new(Mutex::new(ClientControl::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as f64)
            .unwrap_or(0.0)
    })))
}

impl ClientControl {
    pub fn new(now: impl Fn() -> f64 + Send + 'static) -> Self {
        Self {
            workers: Vec::new(),
            requests: Vec::new(),
            now: Box::new(now),
        }
    }

    fn prune(&mut self) {
        let now = (self.now)();
        self.workers.retain(|worker| worker.expires >= now);
        self.requests.retain_mut(|request| {
            if request.deadline + PRUNE_MS < now {
                return false;
            }
            if request.deadline < now && matches!(request.status, "pending" | "claimed") {
                request.status = "failed";
                request.error = Some("client_timeout".into());
            }
            true
        });
    }

    /// Enroll a worker; the credential is returned here and never by `targets`.
    pub fn enroll(&mut self, kind: &str, window: &str) -> Result<Value, CoreError> {
        self.prune();
        if self.workers.len() >= WORKER_LIMIT {
            return Err(CoreError::new(
                Code::Conflict,
                "Too many client control workers",
            ));
        }
        let client_id = uuid_v4();
        let token = hex::encode(rand::random::<[u8; 32]>());
        self.workers.push(Worker {
            client_id: client_id.clone(),
            kind: kind.into(),
            window: window.into(),
            token: token.clone(),
            expires: (self.now)() + LEASE_MS,
        });
        Ok(json!({"client_id": client_id, "worker_token": token}))
    }

    /// Connected workers in insertion order, without credentials or leases.
    pub fn targets(&mut self) -> Value {
        self.prune();
        Value::Array(
            self.workers
                .iter()
                .map(|worker| {
                    json!({
                        "client_id": worker.client_id,
                        "kind": worker.kind,
                        "window": worker.window,
                    })
                })
                .collect(),
        )
    }

    /// Request an allowlisted action on one explicit worker.
    pub fn request(&mut self, client_id: &str, action: Value) -> Result<Value, CoreError> {
        self.prune();
        let Some(worker) = self
            .workers
            .iter()
            .find(|worker| worker.client_id == client_id)
        else {
            return Err(
                CoreError::new(Code::NotFound, "Client is unavailable")
                    .hint("Use client.control.targets to choose a connected client."),
            );
        };
        let action_type = action.get("type").and_then(Value::as_str).unwrap_or_default();
        if worker.window == "tray" && action_type == "navigate" {
            return Err(CoreError::new(Code::NotAllowed, "Navigation requires a main page target")
                .hint("Select a main target to preserve unsaved-form confirmation; use pacer open to launch a screen."));
        }
        // `clientAction.safeParse` strips unknown keys; keep exactly the parsed shape.
        let action = normalize_action(&action);
        if worker.kind != "desktop"
            && matches!(
                action_type,
                "window" | "tray" | "quit" | "launch-at-login"
            )
        {
            return Err(CoreError::new(
                Code::NotAllowed,
                "A native desktop client is required",
            ));
        }
        if self.requests.len() >= REQUEST_LIMIT
            || self.requests.iter().any(|request| {
                request.client_id == client_id && matches!(request.status, "pending" | "claimed")
            })
        {
            return Err(CoreError::new(
                Code::Conflict,
                "Client has an outstanding action",
            ));
        }
        let request = Request {
            request_id: uuid_v4(),
            client_id: client_id.into(),
            action,
            status: "pending",
            deadline: (self.now)() + DEADLINE_MS,
            result: None,
            error: None,
        };
        let value = request_value(&request);
        self.requests.push(request);
        Ok(value)
    }

    fn authorize(&mut self, client_id: &str, token: &str) -> Result<(), CoreError> {
        self.prune();
        let Some(worker) = self
            .workers
            .iter_mut()
            .find(|worker| worker.client_id == client_id)
        else {
            return Err(CoreError::new(
                Code::NotAllowed,
                "Client control credential rejected",
            ));
        };
        let stored = worker.token.as_bytes();
        let offered = token.as_bytes();
        if stored.len() != offered.len() || !bool::from(stored.ct_eq(offered)) {
            return Err(CoreError::new(
                Code::NotAllowed,
                "Client control credential rejected",
            ));
        }
        worker.expires = (self.now)() + LEASE_MS;
        Ok(())
    }

    /// The next pending request for a worker, claimed with its credential; `null` when idle.
    pub fn claim(&mut self, client_id: &str, token: &str) -> Result<Value, CoreError> {
        self.authorize(client_id, token)?;
        let Some(request) = self.requests.iter_mut().find(|request| {
            request.client_id == client_id && request.status == "pending"
        }) else {
            return Ok(Value::Null);
        };
        request.status = "claimed";
        Ok(request_value(request))
    }

    /// A worker acknowledges an applied action, or reports a bounded failure.
    pub fn complete(
        &mut self,
        id: &str,
        token: &str,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Value, CoreError> {
        let owner = {
            let request = self.get(id)?;
            request.client_id.clone()
        };
        self.authorize(&owner, token)?;
        let request = self
            .requests
            .iter_mut()
            .find(|request| request.request_id == id)
            .ok_or_else(|| CoreError::new(Code::NotFound, "Client action expired or does not exist"))?;
        if request.status != "claimed" {
            return Err(CoreError::new(
                Code::Conflict,
                "Client request is not awaiting acknowledgment",
            ));
        }
        if let Some(error) = error {
            request.status = "failed";
            request.error = Some(error);
        } else {
            request.status = "complete";
            request.result = result;
        }
        Ok(request_value(request))
    }

    fn get(&mut self, id: &str) -> Result<&mut Request, CoreError> {
        self.prune();
        self.requests
            .iter_mut()
            .find(|request| request.request_id == id)
            .ok_or_else(|| CoreError::new(Code::NotFound, "Client action expired or does not exist"))
    }

    /// The stored request, including its timeout or acknowledgment.
    pub fn result(&mut self, id: &str) -> Result<Value, CoreError> {
        Ok(request_value(self.get(id)?))
    }
}

/// `Date.now()` is an integer, so TS replies carry an integer deadline. Keep that wire
/// shape where the clock is whole instead of writing serde's `…000.0` float form.
fn milliseconds(ms: f64) -> Value {
    if ms.fract() == 0.0 && ms.abs() < 9_007_199_254_740_992.0 {
        Value::from(ms as i64)
    } else {
        json!(ms)
    }
}

fn request_value(request: &Request) -> Value {
    let mut value = Map::new();
    value.insert("request_id".into(), json!(request.request_id));
    value.insert("client_id".into(), json!(request.client_id));
    value.insert("action".into(), request.action.clone());
    value.insert("status".into(), json!(request.status));
    value.insert("deadline".into(), milliseconds(request.deadline));
    if let Some(result) = &request.result {
        value.insert("result".into(), result.clone());
    }
    if let Some(error) = &request.error {
        value.insert("error".into(), json!(error));
    }
    Value::Object(value)
}

/// The shape `clientAction.safeParse` produces: only known fields, in schema order.
fn normalize_action(action: &Value) -> Value {
    let kind = action.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut out = Map::new();
    out.insert("type".into(), json!(kind));
    let field = |name: &str| action.get(name).cloned().unwrap_or(Value::Null);
    match kind {
        "theme.set" => {
            out.insert("value".into(), field("value"));
        }
        "navigate" => {
            out.insert("route".into(), field("route"));
        }
        "window" | "tray" => {
            out.insert("action".into(), field("action"));
        }
        "launch-at-login" => {
            out.insert("enabled".into(), field("enabled"));
        }
        _ => {}
    }
    Value::Object(out)
}

fn uuid_v4() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests;
