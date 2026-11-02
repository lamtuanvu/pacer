//! One pinned SSH child, bounded stdout reads, and exact host-issued stdin frames.
use crate::native_process::{Image, OwnedChild, terminate_unreaped};
use crate::{AuthorityError, BrokerError};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, ChildStdout, Command},
    task::JoinHandle,
    time::timeout_at,
};
pub struct DuplexSpec {
    pub argv: Vec<String>,
    pub executable: String,
    pub env: HashMap<String, String>,
    pub input: Vec<u8>,
    pub timeout_ms: u64,
}
struct Connection {
    child: OwnedChild,
    input: Option<ChildStdin>,
    output: ChildStdout,
    stderr: JoinHandle<()>,
    stderr_done: bool,
    handle: String,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.stderr.abort();
    }
}
pub struct NativeDuplex {
    spec: DuplexSpec,
    image: Image,
    connection: Option<Connection>,
    used: bool,
    input: Option<(u64, Vec<u8>, bool)>,
}
fn denied() -> BrokerError {
    AuthorityError::Denied("SSH duplex handle or input is not owned by this call".into()).into()
}
fn ms(params: &Value) -> Result<u64, BrokerError> {
    params
        .get("timeoutMs")
        .and_then(crate::js_semantics::safe_u64)
        .filter(|n| (1..=60_000).contains(n))
        .ok_or(BrokerError::Invalid("duplex timeout"))
}
impl NativeDuplex {
    pub fn prepare(mut spec: DuplexSpec) -> Result<Self, BrokerError> {
        if spec.argv.first().map(String::as_str) != Some("ssh")
            || spec.timeout_ms == 0
            || spec.timeout_ms > 60_000
            || spec.input.len() > 65_536
        {
            return Err(denied());
        }
        let image = Image::pin(&spec.executable, true)?;
        let input = if spec.input.is_empty() {
            None
        } else {
            Some((0, std::mem::take(&mut spec.input), false))
        };
        Ok(Self {
            spec,
            image,
            connection: None,
            used: false,
            input,
        })
    }
    pub fn issue_input(&mut self, sequence: u64, bytes: Vec<u8>) -> Result<(), BrokerError> {
        if self.input.is_some() || bytes.is_empty() || bytes.len() > 65_536 {
            return Err(denied());
        }
        self.input = Some((sequence, bytes, false));
        Ok(())
    }
    pub fn acknowledge_input(&mut self, sequence: u64) -> Result<(), BrokerError> {
        if !self
            .input
            .as_ref()
            .is_some_and(|(seq, _, accepted)| *seq == sequence && *accepted)
        {
            return Err(denied());
        }
        if let Some((_, mut bytes, _)) = self.input.take() {
            bytes.fill(0);
        }
        Ok(())
    }
    pub fn revoke(&mut self) {
        self.used = true;
        if let Some((_, mut bytes, _)) = self.input.take() {
            bytes.fill(0);
        }
        if let Some(connection) = self.connection.as_mut() {
            connection.input.take();
            if let Some(pid) = connection.child.id().and_then(|p| i32::try_from(p).ok()) {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(-pid),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
        }
    }
    pub async fn retire_owned(&mut self) -> Result<(), BrokerError> {
        self.revoke();
        if self.connection.is_some() {
            self.close(false).await?;
        }
        Ok(())
    }
    pub async fn close(&mut self, graceful: bool) -> Result<Value, BrokerError> {
        let connection = self.connection.as_mut().ok_or_else(denied)?;
        // EOF on stdin and both output pipes precede reaping the leader. The
        // unreaped PID pins the process-group identity if a descendant lingers.
        connection.input.take();
        let start = std::time::Instant::now();
        let mut terminated = false;
        let mut drained = false;
        if graceful {
            drained = tokio::time::timeout(Duration::from_secs(1), async {
                tokio::io::copy(&mut connection.output, &mut tokio::io::sink())
                    .await
                    .map_err(|_| denied())?;
                if !connection.stderr_done {
                    (&mut connection.stderr).await.map_err(|_| denied())?;
                    connection.stderr_done = true;
                }
                Ok::<_, BrokerError>(())
            })
            .await
            .is_ok_and(|r| r.is_ok());
            if !drained
                || tokio::time::timeout(
                    Duration::from_secs(1).saturating_sub(start.elapsed()),
                    connection.child.wait(),
                )
                .await
                .is_err()
            {
                terminated = true;
                terminate_unreaped(&mut connection.child, Duration::from_millis(500)).await?;
            }
        } else {
            terminated = true;
            terminate_unreaped(&mut connection.child, Duration::from_millis(500)).await?;
        }
        if !drained {
            tokio::time::timeout(Duration::from_secs(2), async {
                tokio::io::copy(&mut connection.output, &mut tokio::io::sink())
                    .await
                    .map_err(|_| denied())?;
                if !connection.stderr_done {
                    (&mut connection.stderr).await.map_err(|_| denied())?;
                    connection.stderr_done = true;
                }
                Ok::<_, BrokerError>(())
            })
            .await
            .map_err(|_| BrokerError::Effect("SSH duplex child cleanup is unverified".into()))??;
        }
        let status = connection
            .child
            .try_wait()
            .map_err(|_| denied())?
            .ok_or_else(denied)?;
        use std::os::unix::process::ExitStatusExt;
        let reply = json!({"ok":true,"code":status.code(),"signal":status.signal().map(|n|nix::sys::signal::Signal::try_from(n).map_or_else(|_|format!("SIG{n}"),|signal|format!("{signal:?}"))),"terminated":terminated});
        self.connection = None;
        if let Some((_, mut bytes, _)) = self.input.take() {
            bytes.fill(0);
        }
        Ok(reply)
    }
    pub async fn answer(
        &mut self,
        method: &str,
        params: &Value,
        deadline: Instant,
    ) -> Result<Value, BrokerError> {
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        if method == "capability.process.duplex.open" {
            if self.used
                || params["argv"] != json!(self.spec.argv)
                || ms(params)? > self.spec.timeout_ms
            {
                return Err(denied());
            }
            self.image.check()?;
            self.used = true;
            let mut child = Command::new(&self.image.canonical)
                .args(&self.spec.argv[1..])
                .env_clear()
                .envs(&self.spec.env)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| BrokerError::Effect("SSH duplex child could not start".into()))?;
            let input = child.stdin.take().ok_or_else(denied)?;
            let output = child.stdout.take().ok_or_else(denied)?;
            let mut stderr = child.stderr.take().ok_or_else(denied)?;
            let stderr = tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            });
            let handle = uuid::Uuid::new_v4().to_string();
            self.connection = Some(Connection {
                child: OwnedChild(child),
                input: Some(input),
                output,
                stderr,
                stderr_done: false,
                handle: handle.clone(),
            });
            return Ok(json!({"handle":handle}));
        }
        let connection = self
            .connection
            .as_mut()
            .filter(|c| params["handle"] == c.handle)
            .ok_or_else(denied)?;
        if method == "capability.process.duplex.close" {
            return self.close(params["graceful"] == true).await;
        }
        let end = deadline.min(Instant::now() + Duration::from_millis(ms(params)?));
        let result = match method {
            "capability.process.duplex.write" => {
                let text = params["base64"]
                    .as_str()
                    .filter(|s| s.len() <= 87_384)
                    .ok_or(BrokerError::Invalid("duplex frame"))?;
                let bytes = STANDARD
                    .decode(text)
                    .map_err(|_| BrokerError::Invalid("duplex base64"))?;
                if bytes.is_empty() || bytes.len() > 65_536 || STANDARD.encode(&bytes) != text {
                    return Err(BrokerError::Invalid("duplex frame"));
                }
                let issued = self
                    .input
                    .as_mut()
                    .filter(|(_, issued, accepted)| !*accepted && *issued == bytes)
                    .ok_or_else(denied)?;
                match timeout_at(
                    end.into(),
                    connection
                        .input
                        .as_mut()
                        .ok_or_else(denied)?
                        .write_all(&bytes),
                )
                .await
                {
                    Ok(Ok(())) => {
                        issued.2 = true;
                        Ok(json!({"bytes":bytes.len()}))
                    }
                    Ok(Err(_)) => Err(BrokerError::Effect("SSH duplex input failed".into())),
                    Err(_) => Err(BrokerError::Timeout),
                }
            }
            "capability.process.duplex.read" => {
                let length = params
                    .get("length")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|n| (1..=65_536).contains(n))
                    .ok_or(BrokerError::Invalid("duplex length"))?
                    as usize;
                let poll = params
                    .get("pollMs")
                    .map(|v| {
                        crate::js_semantics::safe_u64(v)
                            .filter(|n| (1..=250).contains(n))
                            .ok_or(BrokerError::Invalid("duplex poll"))
                    })
                    .transpose()?;
                let mut bytes = vec![0; length];
                let read_end = poll
                    .map(|n| Instant::now() + Duration::from_millis(n))
                    .map_or(end, |p| p.min(end));
                match timeout_at(read_end.into(), connection.output.read(&mut bytes)).await {
                    Ok(Ok(n)) => Ok(json!({"base64":STANDARD.encode(&bytes[..n]),"eof":n==0})),
                    Ok(Err(_)) => Err(BrokerError::Effect("SSH duplex output failed".into())),
                    Err(_) if read_end < end => Ok(json!({"base64":"","eof":false})),
                    Err(_) => Err(BrokerError::Timeout),
                }
            }
            _ => Err(BrokerError::Invalid("unknown duplex method")),
        };
        if result.is_err() {
            self.close(false).await?;
        }
        result
    }
}
impl Drop for NativeDuplex {
    fn drop(&mut self) {
        if let Some((_, bytes, _)) = &mut self.input {
            bytes.fill(0);
        }
    }
}
