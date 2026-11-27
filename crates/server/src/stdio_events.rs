//! Native stdio `snapshot` and `subscribe`. The event timer replays the shared
//! outbox every 500 ms and writes notifications to the same stdout lock as the
//! request/reply loop; no subscription line is sent to Core.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_read_model::{ReadModel, SnapshotInput, events::events_since};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::{Mutex, watch},
    task::JoinHandle,
    time::{Duration, MissedTickBehavior, interval},
};

const POLL: Duration = Duration::from_millis(500);
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn invalid(message: &str) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn local_zone(ctx: &Ctx) -> chrono_tz::Tz {
    if let Some(name) = ctx.env.get("TZ")
        && let Ok(zone) = name.parse()
    {
        return zone;
    }
    std::env::var("TZ")
        .ok()
        .and_then(|name| name.parse().ok())
        .unwrap_or(chrono_tz::UTC)
}

#[cfg(unix)]
fn pid_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    use nix::{sys::signal::kill, unistd::Pid};
    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn pid_alive(_pid: i64) -> bool {
    false
}

fn model() -> &'static std::sync::Mutex<ReadModel> {
    static MODEL: OnceLock<std::sync::Mutex<ReadModel>> = OnceLock::new();
    MODEL.get_or_init(|| std::sync::Mutex::new(ReadModel::new()))
}

/// Compose a snapshot from the TypeScript-owned probe parts. `wire` selects the
/// negotiated protocol shape, exactly as `liveSnapshot`/`liveV2Snapshot` do.
pub async fn snapshot<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    ctx: &Ctx,
    protocol: u8,
    sync: (&str, &str, &mut tokio::sync::mpsc::UnboundedReceiver<Value>),
) -> Result<Value, CoreError> {
    let parts = crate::native::snapshot_sync::stdio(core, sync.0, sync.1, sync.2).await?;
    let bridge = pacer_task_ops::snapshot_get_ops::parse_snapshot_parts(parts)?;
    let alive_pids = bridge.alive_pids;
    let alive = move |pid: i64| alive_pids.contains(&pid);
    let input = SnapshotInput::new(&bridge.probes, bridge.status);
    let result = model()
        .lock()
        .map_err(|_| internal("read model lock poisoned"))?
        .snapshot(ctx, input, local_zone(ctx), &alive)
        .map_err(|error| internal(error.to_string()))?;
    Ok(result.wire(protocol))
}

#[derive(Clone, Copy)]
struct Cursor {
    last: f64,
    protocol: u8,
}

/// One connection's event poller. A `None` cursor means no timer is installed;
/// closing every sender also ends the task, which is what EOF does.
pub struct StdioEvents {
    tx: watch::Sender<Option<Cursor>>,
    task: JoinHandle<()>,
}

impl StdioEvents {
    pub fn start<W: AsyncWrite + Unpin + Send + 'static>(
        out: Arc<Mutex<W>>,
        ctx: Ctx,
    ) -> Self {
        let (tx, rx) = watch::channel(None);
        let task = tokio::spawn(poll(out, ctx, tx.clone(), rx));
        Self { tx, task }
    }

    /// Validate `since` like `src/api/stdio.ts:345-356`, then arm the poller.
    /// The reply's `last` comes from a replay of `since`; the poller's cursor
    /// stays at `since` until its first tick, as TypeScript's `setInterval` does.
    pub fn subscribe(&self, ctx: &Ctx, protocol: u8, params: Option<&Value>) -> Result<Value, CoreError> {
        let params = params.filter(|value| !value.is_null()).unwrap_or(&Value::Null);
        let object = params
            .as_object()
            .ok_or_else(|| invalid("subscribe params must be an object"))?;
        let since = match object.get("since") {
            None | Some(Value::Null) => 0.0,
            Some(Value::Number(number)) => number
                .as_f64()
                .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_SAFE)
                .ok_or_else(|| invalid("since must be a non-negative integer"))?,
            Some(_) => return Err(invalid("since must be a non-negative integer")),
        };
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|error| internal(error.to_string()))?;
        let batch = events_since(&ctx.at_now(), since, protocol, &mut store, local_zone(ctx), &pid_alive)
            .map_err(|error| internal(error.to_string()))?;
        let last = batch["last"].clone();
        self.tx
            .send(Some(Cursor { last: since, protocol }))
            .map_err(|_| CoreError::new(Code::Unavailable, "event subscription closed"))?;
        Ok(json!({"subscribed": true, "last": last}))
    }

    /// A changed `hello` protocol clears the timer and cursor (`stdio.ts:336`).
    pub fn clear(&self) {
        let _ = self.tx.send(None);
    }

    /// EOF clears the timer and stops the task before stdout closes.
    pub async fn stop(self) {
        let _ = self.tx.send(None);
        self.task.abort();
        let _ = self.task.await;
    }
}

async fn poll<W: AsyncWrite + Unpin>(
    out: Arc<Mutex<W>>,
    ctx: Ctx,
    tx: watch::Sender<Option<Cursor>>,
    mut rx: watch::Receiver<Option<Cursor>>,
) {
    let mut store = match TaskStore::open(&ctx.pacer_home) {
        Ok(store) => store,
        Err(_) => return,
    };
    // `setInterval` fires after the first delay, not immediately.
    let mut ticker = interval(POLL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    ticker.tick().await;
    loop {
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            _ = ticker.tick() => {}
        }
        let Some(cursor) = *rx.borrow() else {
            continue;
        };
        let now = ctx.at_now();
        let batch = match events_since(&now, cursor.last, cursor.protocol, &mut store, local_zone(&now), &pid_alive) {
            Ok(batch) => batch,
            Err(_) => {
                let _ = tx.send(None);
                continue;
            }
        };
        for event in batch["events"].as_array().into_iter().flatten() {
            let mut bytes = match serde_json::to_vec(&json!({
                "jsonrpc": "2.0", "method": "event", "params": event,
            })) {
                Ok(bytes) => bytes,
                Err(_) => break,
            };
            bytes.push(b'\n');
            let mut out = out.lock().await;
            if out.write_all(&bytes).await.is_err() || out.flush().await.is_err() {
                drop(out);
                let _ = tx.send(None);
                break;
            }
        }
        if let Some(last) = batch["last"].as_f64()
            && last != cursor.last
        {
            let _ = tx.send(Some(Cursor { last, protocol: cursor.protocol }));
        }
    }
}
