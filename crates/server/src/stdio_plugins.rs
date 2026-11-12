//! Plugin operations on the stdio front door (ADR 0027).
//!
//! The door answers the twelve `plugin.*` operations with the same service as
//! serve. Core's private plugin channel is a sync-keyed `_internal.plugins`
//! line on the core child's stdin; its reply is claimed by id from the child's
//! stdout before any other parsing, so deep or lone-surrogate envelopes never
//! reach the client. Operations run beside the input loop, as on HTTP, so a
//! second action on a busy surface sees `conflict` and later lines are not
//! held behind a plugin call.
//!
//! Who runs plugin processes is decided once, before the core child starts:
//! Core (native host off), the live serve owner at `run/host.sock` (attach),
//! or an owner of this connection's own on `run/s<12-hex>.sock` (own; a private
//! per-user directory when that path is too long), torn down when the
//! connection ends or the door receives SIGTERM. Flag-off, Core owns the
//! children and never sees an inherited `PACER_HOST_SOCKET`.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::native::plugins::{ProcessRpc, Service, is_read};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, Registry},
};
use pacer_plugin_ops::{
    ipc::{CoreIpc, Exchange, Failure, MAX_REPLY_BYTES},
    json,
    settings::js_json,
};
use pacer_plugin_runtime::{
    CrashReport, HOST_SOCKET_ENV, HomeOwner, NativeHostSession,
    native_plugin_host_enabled_from_env, probe_home_owner,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    process::Command,
    sync::{mpsc, oneshot},
    task::JoinSet,
};

type Reply = Result<Vec<u8>, Failure>;

/// Core's private plugin channel over the core child's stdio.
pub(crate) struct PluginLink {
    key: String,
    id_prefix: String,
    line_prefix: String,
    next: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
}

impl PluginLink {
    /// The receiver yields request lines the input loop must write to the core child.
    pub(crate) fn new(sync_id: &str, key: &str) -> (Arc<Self>, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (frames, rx) = mpsc::unbounded_channel();
        let id_prefix = format!("{sync_id}:p");
        let link = Self {
            key: key.to_owned(),
            line_prefix: format!(r#"{{"jsonrpc":"2.0","id":"{id_prefix}"#),
            id_prefix,
            next: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            frames,
        };
        (Arc::new(link), rx)
    }

    /// Claim a core stdout line that answers a plugin request; false for any other line.
    ///
    /// Core writes `{"jsonrpc":"2.0","id":"<id>","result":<envelope>}`, so the
    /// envelope is the exact bytes between `"result":` and the closing brace,
    /// identical to the HTTP response body.
    pub(crate) fn route(&self, line: &[u8]) -> bool {
        let Some(rest) = line.strip_prefix(self.line_prefix.as_bytes()) else {
            return false;
        };
        let Some(end) = rest.iter().position(|b| *b == b'"') else {
            return true;
        };
        let id = format!(
            "{}{}",
            self.id_prefix,
            String::from_utf8_lossy(&rest[..end])
        );
        let tail = rest[end + 1..]
            .strip_suffix(b"\n")
            .unwrap_or(&rest[end + 1..]);
        let reply = match tail
            .strip_prefix(br#","result":"#)
            .and_then(|payload| payload.strip_suffix(b"}"))
        {
            Some(payload) if payload.len() > MAX_REPLY_BYTES => {
                Err(Failure::Body("length limit exceeded".into()))
            }
            Some(payload) => Ok(payload.to_vec()),
            // The core refused the sealed request (wrong key, pre-hello, work grant).
            None => Err(Failure::Refused),
        };
        if let Some(sender) = self.pending.lock().ok().and_then(|mut p| p.remove(&id)) {
            let _ = sender.send(reply);
        }
        true
    }
}

struct Pending<'a> {
    link: &'a PluginLink,
    id: String,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.link.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl CoreIpc for PluginLink {
    fn exchange(&self, body: String) -> Exchange<'_> {
        Box::pin(async move {
            let id = format!(
                "{}{:016x}",
                self.id_prefix,
                self.next.fetch_add(1, Ordering::Relaxed)
            );
            let (sender, receiver) = oneshot::channel();
            self.pending
                .lock()
                .map_err(|_| Failure::Unavailable)?
                .insert(id.clone(), sender);
            let _pending = Pending { link: self, id };
            // `body` is already private-IPC JSON; embedding it verbatim keeps
            // lone surrogates and Infinity exactly as the HTTP door sends them.
            let line = format!(
                r#"{{"jsonrpc":"2.0","id":"{}","method":"_internal.plugins","params":{{"key":"{}","request":{body}}}}}"#,
                _pending.id, self.key
            );
            let mut line = line.into_bytes();
            line.push(b'\n');
            self.frames.send(line).map_err(|_| Failure::Unavailable)?;
            receiver.await.unwrap_or(Err(Failure::Unavailable))
        })
    }
}

/// The core child's `PACER_HOST_SOCKET`, which tells Core who runs plugin processes.
pub(crate) enum HostSocket {
    /// Scoped work forwards everything and keeps what it inherited.
    Inherit,
    /// Core owns the children; an inherited socket was never probed by this door.
    Unset,
    Set(String),
}

impl HostSocket {
    pub(crate) fn apply<'a>(&self, command: &'a mut Command) -> &'a mut Command {
        match self {
            Self::Inherit => command,
            Self::Unset => command.env_remove(HOST_SOCKET_ENV),
            Self::Set(socket) => command.env(HOST_SOCKET_ENV, socket),
        }
    }
}

/// Who owns this connection's plugin processes, and its plugin service.
pub(crate) struct Ownership {
    pub(crate) service: Arc<Service>,
    session: Option<NativeHostSession>,
}

impl Ownership {
    /// Decide before the core child spawns; returns the core child's owner socket.
    pub(crate) async fn start(
        env: &HashMap<String, String>,
        pacer_home: &Path,
        scoped_work: bool,
    ) -> io::Result<(Self, HostSocket)> {
        if scoped_work || !native_plugin_host_enabled_from_env(env) {
            let socket = if scoped_work {
                HostSocket::Inherit
            } else {
                HostSocket::Unset
            };
            return Ok((
                Self {
                    service: Arc::new(Service::default()),
                    session: None,
                },
                socket,
            ));
        }
        let debug = std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1");
        match probe_home_owner(pacer_home) {
            HomeOwner::Live(socket) => {
                if debug {
                    eprintln!("native plugin owner attach {}", socket.display());
                }
                let core_socket = HostSocket::Set(socket.display().to_string());
                let service = Service::with_process_rpc(ProcessRpc::Attached(socket));
                Ok((
                    Self {
                        service: Arc::new(service),
                        session: None,
                    },
                    core_socket,
                ))
            }
            found => {
                if let HomeOwner::Untrusted(reason) = found {
                    eprintln!("pacer: not attaching to the plugin owner: {reason}");
                }
                // A deep home asks `getconf` for the per-user directory: keep it off the runtime.
                let home = pacer_home.to_path_buf();
                let (session, _) = tokio::task::spawn_blocking(move || {
                    NativeHostSession::start_connection(&home, rand::random())
                })
                .await
                .map_err(io::Error::other)?
                .map_err(|error| io::Error::other(format!("native plugin host: {error}")))?;
                if debug {
                    eprintln!(
                        "native plugin owner own {}",
                        session.socket_path().display()
                    );
                }
                let core_socket = HostSocket::Set(session.socket_path().display().to_string());
                let service = Service::with_native_owner(Arc::clone(session.owner()));
                Ok((
                    Self {
                        service: Arc::new(service),
                        session: Some(session),
                    },
                    core_socket,
                ))
            }
        }
    }

    /// True when this connection runs its own plugin children and socket.
    pub(crate) fn owns_children(&self) -> bool {
        self.session.is_some()
    }

    /// Crashes of the children this connection owns. An attached connection
    /// gets none: the serve owner reports to serve's Core (ADR 0027).
    pub(crate) fn crash_reports(&self) -> Option<mpsc::UnboundedReceiver<CrashReport>> {
        self.session.as_ref().map(NativeHostSession::crash_reports)
    }

    /// Unlink this connection's socket and terminate the children it owns.
    pub(crate) async fn finish(self) {
        if let Some(session) = self.session {
            session.shutdown_connection().await;
        }
    }
}

/// A plugin operation line, decoded with the JavaScript-compatible codec.
pub(crate) enum Line {
    Answer {
        op: &'static str,
        id: Option<Value>,
        params: Value,
    },
    /// Core answers it: nesting past the native budget, an invalid request,
    /// or an id only JavaScript echoes faithfully.
    Forward,
}

/// Classify a protocol-3 line. `None` when it is not a native plugin operation.
pub(crate) fn classify(
    line: &[u8],
    request: Option<&Value>,
    registry: &Registry<'_>,
    answered_id: impl Fn(&Value) -> bool,
) -> Option<Line> {
    if let Some(request) = request {
        let method = request.get("method").and_then(Value::as_str)?;
        if !method.starts_with("plugin.") || registry.get(method).is_none() {
            return None;
        }
    }
    let value = match json::parse_body(line) {
        Ok(value) => value,
        // Serde read it as a native plugin op; only the nesting budget refuses it here.
        Err(_) if request.is_some() => return Some(Line::Forward),
        Err(_) => return None,
    };
    let method = value.get("method").and_then(Value::as_str)?;
    if !method.starts_with("plugin.") {
        return None;
    }
    let op = registry.get(method)?.name;
    let id = value.get("id");
    let valid = value["jsonrpc"] == "2.0"
        && id.is_none_or(|id| id.is_null() || id.is_string() || id.is_number());
    if !valid || id.is_some_and(|id| json::nonfinite(id) || !answered_id(id)) {
        return Some(Line::Forward);
    }
    let params = match value.get("params") {
        None | Some(Value::Null) => json!({}),
        Some(params) => params.clone(),
    };
    Some(Line::Answer {
        op,
        id: id.cloned(),
        params,
    })
}

/// What a finished plugin operation asks the input loop to do.
pub(crate) enum Done {
    Reply(Vec<u8>),
    /// Send the original line to Core: a read whose native envelope exceeded the
    /// nesting budget. Mutations never replay.
    Replay(Vec<u8>),
    Nothing,
}

/// Run one plugin operation beside the input loop.
pub(crate) fn spawn(
    tasks: &mut JoinSet<Done>,
    ids: &mut HashMap<tokio::task::Id, Value>,
    service: &Arc<Service>,
    link: &Arc<PluginLink>,
    ctx: Ctx,
    request: (&'static str, Option<Value>, Value),
    line: Vec<u8>,
) {
    let (op, id, params) = request;
    if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
        match &id {
            Some(id) => eprintln!("native {op} {}", json::stringify(id)),
            None => eprintln!("native {op}"),
        }
    }
    let service = Arc::clone(service);
    let ipc: Arc<dyn CoreIpc> = link.clone();
    let reply_id = id.clone();
    let task = tasks.spawn(async move {
        let core = async { Some((ipc, String::from("stdio"))) };
        let result = service.call(&ctx, core, op, params).await;
        if is_read(op)
            && result.as_ref().is_err_and(|error| {
                error.code == Code::Unavailable && error.message == json::NESTING_FALLBACK
            })
        {
            return Done::Replay(line);
        }
        match reply_id {
            Some(id) => Done::Reply(reply(&id, result)),
            None => Done::Nothing,
        }
    });
    if let Some(id) = id {
        ids.insert(task.id(), id);
    }
}

/// The finished task's action; a panicked operation still answers its request.
pub(crate) fn finished(
    ids: &mut HashMap<tokio::task::Id, Value>,
    done: Result<(tokio::task::Id, Done), tokio::task::JoinError>,
) -> Done {
    match done {
        Ok((task, done)) => {
            ids.remove(&task);
            done
        }
        Err(error) => match ids.remove(&error.id()) {
            Some(id) => Done::Reply(reply(
                &id,
                Err(CoreError::new(Code::Internal, "plugin operation failed")),
            )),
            None => Done::Nothing,
        },
    }
}

fn reply(id: &Value, result: Result<Value, CoreError>) -> Vec<u8> {
    let response = match result {
        Ok(value) => json!({"jsonrpc":"2.0", "id":id, "result":value}),
        Err(error) => json!({"jsonrpc":"2.0", "id":id, "error":error.rpc()}),
    };
    let mut bytes = js_json(&response).into_bytes();
    bytes.push(b'\n');
    bytes
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn registry(forward: &str) -> Registry<'static> {
        crate::native::service_registry(forward)
    }

    fn classify_text(text: &str, forward: &str) -> Option<Line> {
        let request = serde_json::from_str::<Value>(text).ok();
        classify(
            text.as_bytes(),
            request.as_ref(),
            &registry(forward),
            |_| true,
        )
    }

    #[test]
    fn only_registered_plugin_ops_are_answered() {
        assert!(matches!(
            classify_text(r#"{"jsonrpc":"2.0","id":1,"method":"plugin.list"}"#, ""),
            Some(Line::Answer {
                op: "plugin.list",
                ..
            })
        ));
        assert!(
            classify_text(
                r#"{"jsonrpc":"2.0","id":1,"method":"plugin.list"}"#,
                "plugin.list"
            )
            .is_none()
        );
        assert!(classify_text(r#"{"jsonrpc":"2.0","id":1,"method":"config.get"}"#, "").is_none());
        assert!(classify_text(r#"{"jsonrpc":"2.0","id":1,"method":"plugin.nope"}"#, "").is_none());
    }

    #[test]
    fn lone_surrogates_and_deep_lines_use_the_js_codec() {
        // Serde refuses the lone surrogate; the JS codec keeps it quoted.
        let line = r#"{"jsonrpc":"2.0","id":"\ud800","method":"plugin.settings.get","params":{"id":"\udfff"}}"#;
        let Some(Line::Answer { id, params, .. }) = classify_text(line, "") else {
            panic!("answered");
        };
        assert_eq!(json::stringify(&id.unwrap()), r#""\ud800""#);
        assert_eq!(json::stringify(&params), r#"{"id":"\udfff"}"#);
        let deep = |depth: usize| {
            format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"plugin.list","params":{{"x":{}{}}}}}"#,
                "[".repeat(depth),
                "]".repeat(depth)
            )
        };
        // Past serde's 128 levels but inside the JS budget: still answered natively.
        assert!(matches!(
            classify_text(&deep(300), ""),
            Some(Line::Answer {
                op: "plugin.list",
                ..
            })
        ));
        // Past both budgets: the raw line goes to the core unchanged.
        assert!(classify_text(&deep(600), "").is_none());
        assert!(classify_text("{nope", "").is_none());
    }

    #[test]
    fn invalid_requests_and_unsafe_ids_go_to_core() {
        for line in [
            r#"{"jsonrpc":"1.0","id":1,"method":"plugin.list"}"#,
            r#"{"jsonrpc":"2.0","id":[1],"method":"plugin.list"}"#,
            r#"{"jsonrpc":"2.0","id":1e400,"method":"plugin.list"}"#,
        ] {
            assert!(
                matches!(classify_text(line, ""), Some(Line::Forward)),
                "{line}"
            );
        }
    }

    #[tokio::test]
    async fn replies_are_claimed_by_id_and_refusals_map() {
        let (link, mut frames) = PluginLink::new("abc", "k3y");
        let exchange = {
            let link = Arc::clone(&link);
            tokio::spawn(async move {
                link.exchange(r#"{"kind":"stop","id":"\ud800"}"#.into())
                    .await
            })
        };
        let frame = String::from_utf8(frames.recv().await.unwrap()).unwrap();
        assert_eq!(
            frame,
            "{\"jsonrpc\":\"2.0\",\"id\":\"abc:p0000000000000000\",\"method\":\"_internal.plugins\",\"params\":{\"key\":\"k3y\",\"request\":{\"kind\":\"stop\",\"id\":\"\\ud800\"}}}\n"
        );
        assert!(!link.route(b"{\"jsonrpc\":\"2.0\",\"id\":\"abc:0000\",\"result\":1}\n"));
        assert!(!link.route(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1}\n"));
        assert!(link.route(
            b"{\"jsonrpc\":\"2.0\",\"id\":\"abc:p0000000000000000\",\"result\":{\"value\":\"\\udfff\",\"entries\":[]}}\n"
        ));
        assert_eq!(
            exchange.await.unwrap().unwrap(),
            br#"{"value":"\udfff","entries":[]}"#
        );

        let refused = {
            let link = Arc::clone(&link);
            tokio::spawn(async move { link.exchange("{}".into()).await })
        };
        frames.recv().await.unwrap();
        assert!(link.route(
            b"{\"jsonrpc\":\"2.0\",\"id\":\"abc:p0000000000000001\",\"error\":{\"code\":-32601,\"message\":\"unknown operation\"}}\n"
        ));
        assert_eq!(refused.await.unwrap(), Err(Failure::Refused));
        assert!(link.pending.lock().unwrap().is_empty());
    }
}
