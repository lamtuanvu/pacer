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
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn peer(script: &str) -> SpawnSpec {
        SpawnSpec {
            argv: vec!["bun".into(), "-e".into(), script.into()],
            cwd: std::env::current_dir().unwrap(),
            env: std::env::vars().collect(),
        }
    }

    #[test]
    fn wire_limit_counts_complete_utf8_frame() {
        assert_eq!(
            frame(json!({"jsonrpc":"2.0","id":1,"result":"界"}))
                .unwrap()
                .last(),
            Some(&b'\n')
        );
        assert!(matches!(
            frame(json!({"body":"a".repeat(MAX_LINE_BYTES)})),
            Err(ProcessError::TooLarge)
        ));
        assert!(matches!(parse_frame(b"{bad"), Err(ProcessError::Malformed)));
    }

    #[tokio::test]
    async fn child_parent_pid_and_cancel_frame() {
        let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const line=text.slice(0,cut);text=text.slice(cut+1);const m=JSON.parse(line);if(m.method==='probe'){console.log('malformed');console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ppid:process.ppid}}));}if(m.method==='$/cancel')console.log(JSON.stringify({jsonrpc:'2.0',id:99,result:{cancelled:m.params.id}}));}}"#;
        let mut child = PluginProcess::spawn(&peer(script)).unwrap();
        let pid = child.pid().unwrap();
        let result = child
            .request("probe", json!({}), Duration::from_secs(5), None)
            .await
            .unwrap();
        assert_eq!(result["ppid"], std::process::id());
        assert_ne!(pid, std::process::id());
        child.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn deadline_cancels_without_leaving_a_child() {
        let script = r#"const reader=Bun.stdin.stream().getReader();await reader.read();await new Promise(resolve=>setTimeout(resolve,10000));"#;
        let mut child = PluginProcess::spawn(&peer(script)).unwrap();
        let result = child
            .request("probe", json!({}), Duration::from_millis(100), None)
            .await;
        assert!(matches!(result, Err(ProcessError::Timeout)));
        child.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn deadline_covers_blocked_stdin_write() {
        let script = "await new Promise(resolve => setTimeout(resolve, 10000));";
        let mut child = PluginProcess::spawn(&peer(script)).unwrap();
        let result = child
            .request(
                "probe",
                json!({"payload":"x".repeat(MAX_LINE_BYTES - 200)}),
                Duration::from_millis(100),
                None,
            )
            .await;
        assert!(matches!(result, Err(ProcessError::Timeout)));
        child.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn plugin_to_host_request_receives_result_and_denial() {
        let script = r#"const reader=Bun.stdin.stream().getReader();let buf='',denied;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await reader.read();if(done)break;buf+=new TextDecoder().decode(value);while(buf.includes('\n')){let i=buf.indexOf('\n'),m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(m.method==='probe')send({id:7,method:'capability.log',params:{level:'info',message:'fixture'}});else if(m.id===7){if(m.result?.ok!==true)process.exit(2);send({id:8,method:'capability.fs.write',params:{}})}else if(m.id===8){denied=m.error?.data?.code;send({id:9,method:'mystery',params:{}})}else if(m.id===9){send({id:1,result:{denied,unknown:m.error?.code}})}}}"#;
        let mut child = PluginProcess::spawn(&peer(script)).unwrap();
        let result = child
            .request_with_handler(
                "probe",
                json!({}),
                Duration::from_secs(5),
                None,
                |method, _, _| async move {
                    if method == "capability.log" {
                        Ok(json!({"ok":true}))
                    } else if method.starts_with("capability.") {
                        Err(rpc_error(
                            "capability_denied",
                            format!("capability is not granted: {method}"),
                        ))
                    } else {
                        Err(rpc_error(
                            "unknown_op",
                            format!("unknown host method: {method}"),
                        ))
                    }
                },
            )
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"denied":"capability_denied","unknown":-32601})
        );
        child.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn default_handler_refuses_ungranted_and_unknown_methods() {
        let script = r#"const r=Bun.stdin.stream().getReader();let b='',denied;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='probe')send({id:7,method:'capability.log',params:{}});else if(m.id===7){denied=m.error;send({id:8,method:'unknown.method',params:{}})}else if(m.id===8)send({id:1,result:{denied,unknown:m.error}})}}"#;
        let mut child = PluginProcess::spawn(&peer(script)).unwrap();
        let result = child
            .request("probe", json!({}), Duration::from_secs(5), None)
            .await
            .unwrap();
        assert_eq!(result["denied"]["code"], -32000);
        assert_eq!(result["denied"]["data"]["code"], "capability_denied");
        assert_eq!(result["unknown"]["code"], -32601);
        assert_eq!(result["unknown"]["data"]["code"], "unknown_op");
        child.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn owner_cancellation_sends_cancel_notification() {
        let receipt =
            std::env::temp_dir().join(format!("pacer-plugin-cancel-{}", std::process::id()));
        let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const m=JSON.parse(text.slice(0,cut));text=text.slice(cut+1);if(m.method==='$/cancel')await Bun.write(process.env.PACER_CANCEL_RECEIPT,String(m.params.id));}}"#;
        let mut spec = peer(script);
        spec.env.insert(
            "PACER_CANCEL_RECEIPT".into(),
            receipt.to_string_lossy().into_owned(),
        );
        let mut child = PluginProcess::spawn(&spec).unwrap();
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let trigger = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            sender.send(true).unwrap();
        });
        let result = child
            .request("probe", json!({}), Duration::from_secs(5), Some(&receiver))
            .await;
        assert!(matches!(result, Err(ProcessError::Cancelled)));
        trigger.await.unwrap();
        let seen = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(&receipt) {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(seen, "1");
        child.terminate().await.unwrap();
        std::fs::remove_file(receipt).unwrap();
    }

    #[tokio::test]
    async fn conformance_fixture_handshake_and_ping() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let fixture = root.join("conformance/fixtures");
        let dir = root
            .join(".work/fixtures")
            .join(format!("p4a-serial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (source, destination) in [
            ("serial/main.ts", "main.ts"),
            ("serial/fixture.json", "fixture.json"),
            ("serial/pacer-plugin.json", "pacer-plugin.json"),
            ("plugin.ts", "plugin.ts"),
        ] {
            std::fs::copy(fixture.join(source), dir.join(destination)).unwrap();
        }
        std::fs::write(dir.join("fixture.json"), r#"{"callCapability":"log"}"#).unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(dir.join("pacer-plugin.json")).unwrap()).unwrap();
        let mut spec = peer("");
        spec.argv = vec!["bun".into(), "main.ts".into()];
        spec.cwd = dir.clone();
        let mut child = PluginProcess::spawn(&spec).unwrap();
        let hello = child.request("plugin.hello", json!({"protocol":"1.10.0","pacer":"0.2.0","manifest":manifest,"config":{},"grants":[],"features":[]}), Duration::from_secs(5), None).await.unwrap();
        assert_eq!(hello["id"], "fx-serial");
        assert_eq!(hello["protocol"], "1.10.0");
        let ping = child
            .request_with_handler(
                "diagnostic.ping",
                json!({}),
                Duration::from_secs(5),
                None,
                |method, params, _| async move {
                    assert_eq!(method, "capability.log");
                    assert_eq!(params["message"], "hello from fixture");
                    Ok(json!({"ok":true}))
                },
            )
            .await
            .unwrap();
        assert_eq!(ping["ok"], true);
        child.terminate().await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
