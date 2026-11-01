use serde_json::{Value, json};
use std::{collections::HashMap, future::Future, path::PathBuf, process::Stdio, time::Duration};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    time::{Instant, timeout, timeout_at},
};

pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("plugin process is unavailable: {0}")]
    Unavailable(String),
    #[error("plugin frame exceeds 1 MiB")]
    TooLarge,
    #[error("plugin request timed out")]
    Timeout,
    #[error("plugin response is malformed")]
    Malformed,
    #[error("plugin request was cancelled")]
    Cancelled,
}

/// The caller supplies a complete, already sealed environment. No shell is used.
#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}

#[derive(Debug, PartialEq)]
pub enum ProcessFrame {
    Response {
        id: u64,
        result: Value,
    },
    Error {
        id: u64,
        error: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
        metadata: Option<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
}

pub fn frame(value: Value) -> Result<Vec<u8>, ProcessError> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| ProcessError::Malformed)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_LINE_BYTES {
        return Err(ProcessError::TooLarge);
    }
    Ok(bytes)
}

pub fn parse_frame(line: &[u8]) -> Result<ProcessFrame, ProcessError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(ProcessError::TooLarge);
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| ProcessError::Malformed)?;
    let object = value.as_object().ok_or(ProcessError::Malformed)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(ProcessError::Malformed);
    }
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        return Ok(match object.get("id") {
            Some(id) if !id.is_null() => ProcessFrame::Request {
                id: id.clone(),
                method: method.into(),
                params,
                metadata: object.get("_meta").cloned(),
            },
            _ => ProcessFrame::Notification {
                method: method.into(),
                params,
            },
        });
    }
    let id = object
        .get("id")
        .and_then(Value::as_u64)
        .ok_or(ProcessError::Malformed)?;
    if let Some(error) = object.get("error") {
        return Ok(ProcessFrame::Error {
            id,
            error: error.clone(),
        });
    }
    Ok(ProcessFrame::Response {
        id,
        result: object
            .get("result")
            .cloned()
            .ok_or(ProcessError::Malformed)?,
    })
}

async fn read_line_bounded(stream: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>, ProcessError> {
    let mut line = Vec::new();
    let mut byte = [0];
    let mut dropping = false;
    loop {
        match stream.read(&mut byte).await {
            Ok(0) if line.is_empty() && !dropping => {
                return Err(ProcessError::Unavailable("stdout closed".into()));
            }
            Ok(0) if dropping => return Err(ProcessError::TooLarge),
            Ok(0) => return Ok(line),
            Ok(_) if byte[0] == b'\n' => {
                if dropping {
                    return Err(ProcessError::TooLarge);
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(line);
            }
            Ok(_) if !dropping => {
                line.push(byte[0]);
                if line.len() > MAX_LINE_BYTES {
                    line.clear();
                    dropping = true;
                }
            }
            Ok(_) => {}
            Err(error) => return Err(ProcessError::Unavailable(error.to_string())),
        }
    }
}

/// A single owned child for transport characterization; registry integration waits for P4d.
pub struct PluginProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: tokio::process::ChildStdout,
    next_id: u64,
}

impl PluginProcess {
    pub fn spawn(spec: &SpawnSpec) -> Result<Self, ProcessError> {
        let (program, args) = spec
            .argv
            .split_first()
            .ok_or_else(|| ProcessError::Unavailable("empty argv".into()))?;
        let mut child = Command::new(program);
        child
            .args(args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = child
            .spawn()
            .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProcessError::Unavailable("stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProcessError::Unavailable("stdout unavailable".into()))?;
        Ok(Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> Result<Value, ProcessError> {
        self.request_with_handler(
            method,
            params,
            deadline,
            cancel,
            |method, _, _| async move {
                let (code, message) = if known_capability(&method) {
                    ("capability_denied", "capability is not granted")
                } else {
                    ("unknown_op", "unknown host method")
                };
                Err(rpc_error(code, format!("{message}: {method}")))
            },
        )
        .await
    }

    /// The handler runs for plugin-to-host requests while the parent call is pending.
    /// It must return a JSON-RPC error object for refused capabilities.
    pub async fn request_with_handler<F, Fut>(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&tokio::sync::watch::Receiver<bool>>,
        mut handler: F,
    ) -> Result<Value, ProcessError>
    where
        F: FnMut(String, Value, Option<Value>) -> Fut,
        Fut: Future<Output = Result<Value, Value>>,
    {
        if cancel.is_some_and(|signal| *signal.borrow()) {
            return Err(ProcessError::Cancelled);
        }
        let id = self.next_id;
        self.next_id += 1;
        let request = frame(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let expires = Instant::now() + deadline;
        let exchange = async {
            self.stdin
                .write_all(&request)
                .await
                .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
            loop {
                let line = match read_line_bounded(&mut self.stdout).await {
                    Ok(line) => line,
                    Err(ProcessError::TooLarge) => continue,
                    Err(error) => return Err(error),
                };
                let parsed = match parse_frame(&line) {
                    Ok(parsed) => parsed,
                    Err(ProcessError::Malformed | ProcessError::TooLarge) => continue,
                    Err(error) => return Err(error),
                };
                match parsed {
                    ProcessFrame::Response {
                        id: received,
                        result,
                    } if received == id => return Ok(result),
                    ProcessFrame::Error {
                        id: received,
                        error,
                    } if received == id => {
                        return Err(ProcessError::Unavailable(error.to_string()));
                    }
                    ProcessFrame::Notification { .. } => {}
                    ProcessFrame::Request {
                        id: child_id,
                        method,
                        params,
                        metadata,
                    } => {
                        let reply = match handler(method, params, metadata).await {
                            Ok(result) => json!({"jsonrpc":"2.0","id":child_id,"result":result}),
                            Err(error) => json!({"jsonrpc":"2.0","id":child_id,"error":error}),
                        };
                        let bytes = frame(reply)?;
                        self.stdin
                            .write_all(&bytes)
                            .await
                            .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
                    }
                    _ => {}
                }
            }
        };
        let outcome = if let Some(cancel) = cancel {
            let mut cancel = cancel.clone();
            tokio::select! {
                result = timeout_at(expires, exchange) => result.unwrap_or(Err(ProcessError::Timeout)),
                _ = cancel.changed() => Err(ProcessError::Cancelled),
            }
        } else {
            timeout_at(expires, exchange)
                .await
                .unwrap_or(Err(ProcessError::Timeout))
        };
        if matches!(
            outcome,
            Err(ProcessError::Timeout | ProcessError::Cancelled)
        ) {
            let cancel = frame(json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":id}}))?;
            let _ = timeout(Duration::from_millis(100), self.stdin.write_all(&cancel)).await;
        }
        outcome
    }

    pub async fn terminate(mut self) -> Result<(), ProcessError> {
        if self
            .child
            .try_wait()
            .map_err(|error| ProcessError::Unavailable(error.to_string()))?
            .is_some()
        {
            return Ok(());
        }
        // Rust owns this child. The two-second grace mirrors the TypeScript transport.
        #[cfg(unix)]
        {
            let pid = self
                .child
                .id()
                .ok_or_else(|| ProcessError::Unavailable("missing pid".into()))?;
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()
                .await;
        }
        if timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            self.child
                .start_kill()
                .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
            self.child
                .wait()
                .await
                .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
        }
        Ok(())
    }
}

fn rpc_error(code: &str, message: String) -> Value {
    json!({"code": if code == "unknown_op" { -32601 } else { -32000 },
        "message": message, "data": {"code": code}})
}

fn known_capability(method: &str) -> bool {
    let Some(name) = method.strip_prefix("capability.") else {
        return false;
    };
    [
        "tasks.read",
        "events.subscribe",
        "process.spawn",
        "fs.read",
        "net.http",
        "secrets.resolve",
        "config.get",
        "entitlement.report",
        "log",
        "identity.sign",
        "net.p2p",
        "fs.write",
        "worktree",
        "usage.state",
        "hosts",
        "orca",
    ]
    .iter()
    .any(|capability| name == *capability || name.starts_with(&format!("{capability}.")))
}

#[cfg(test)]
mod tests;
