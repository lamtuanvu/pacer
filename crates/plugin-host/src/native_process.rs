//! Host-issued executable images and exact argv/context. Never reads ambient credentials.
use crate::{AuthorityError, BrokerError, CommandResource};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::timeout,
};

fn denied() -> BrokerError {
    crate::AuthorityError::Denied("provider command image or context changed".into()).into()
}
pub(crate) struct OwnedChild(pub(crate) Child);
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|s| s.is_none())
            && let Some(pid) = self.0.id().and_then(|p| i32::try_from(p).ok())
        {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(-pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}
pub(crate) struct Image {
    logical: PathBuf,
    pub(crate) canonical: PathBuf,
    link: Metadata,
    target: Metadata,
    directory: bool,
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.len() == b.len()
        && mtime_ms(a) == mtime_ms(b)
}
fn mtime_ms(m: &Metadata) -> f64 {
    m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6
}
impl Image {
    pub(crate) fn pin(path: &str, executable: bool) -> Result<Self, BrokerError> {
        if !Path::new(path).is_absolute() {
            return Err(denied());
        }
        let logical = PathBuf::from(path);
        let canonical = fs::canonicalize(path).map_err(|_| denied())?;
        let link = fs::symlink_metadata(path).map_err(|_| denied())?;
        let target = fs::metadata(&canonical).map_err(|_| denied())?;
        if if executable {
            !target.is_file() || target.mode() & 0o111 == 0
        } else {
            !target.is_dir()
        } {
            return Err(denied());
        }
        Ok(Self {
            logical,
            canonical,
            link,
            target,
            directory: !executable,
        })
    }
    pub(crate) fn check(&self) -> Result<(), BrokerError> {
        let matches = |a: &Metadata, b: &Metadata| {
            if self.directory {
                a.dev() == b.dev() && a.ino() == b.ino() && a.mode() == b.mode()
            } else {
                same(a, b)
            }
        };
        if fs::canonicalize(&self.logical).ok().as_ref() != Some(&self.canonical)
            || !fs::symlink_metadata(&self.logical).is_ok_and(|m| matches(&m, &self.link))
            || !fs::metadata(&self.canonical).is_ok_and(|m| matches(&m, &self.target))
        {
            return Err(denied());
        }
        Ok(())
    }
}
struct Pin {
    command: CommandResource,
    executable: Option<Image>,
    cwd: Option<Image>,
}
pub struct NativeProcess {
    pins: Vec<Pin>,
    environment: HashMap<String, String>,
    output: HashMap<String, Vec<u8>>,
    used: HashSet<crate::SpawnMode>,
    credentials: crate::CredentialBindings,
    capture: Option<crate::NativeWrite>,
    cleanup_failed: bool,
}
impl NativeProcess {
    /// `selected` is resolved by the trusted owner before plugin execution.
    pub fn prepare(
        commands: &[CommandResource],
        selected: &HashMap<String, String>,
        environment: &HashMap<String, String>,
    ) -> Result<Self, BrokerError> {
        Self::prepare_account(commands, selected, environment, None)
    }
    pub fn prepare_account(
        commands: &[CommandResource],
        selected: &HashMap<String, String>,
        environment: &HashMap<String, String>,
        account_home: Option<&str>,
    ) -> Result<Self, BrokerError> {
        let mut pins = vec![];
        for command in commands {
            command.validate(account_home)?;
            let executable = selected
                .get(&command.argv[0])
                .map(|p| Image::pin(p, true))
                .transpose()?;
            let cwd = command
                .cwd
                .as_ref()
                .map(|p| Image::pin(p, false))
                .transpose()?;
            pins.push(Pin {
                command: command.clone(),
                executable,
                cwd,
            });
        }
        Ok(Self {
            pins,
            environment: environment.clone(),
            output: HashMap::new(),
            used: HashSet::new(),
            credentials: crate::CredentialBindings::default(),
            capture: None,
            cleanup_failed: false,
        })
    }
    pub fn with_credentials(mut self, credentials: crate::CredentialBindings) -> Self {
        self.credentials = credentials;
        self
    }
    pub fn with_capture(mut self, capture: crate::NativeWrite) -> Self {
        self.capture = Some(capture);
        self
    }
    pub fn clear_output(&mut self) {
        for bytes in self.output.values_mut() {
            bytes.fill(0);
        }
        self.output.clear();
    }
    pub fn output_chunk(&self, params: &Value) -> Result<Value, BrokerError> {
        let handle = params["handle"]
            .as_str()
            .ok_or(BrokerError::Invalid("output handle"))?;
        let bytes = self.output.get(handle).ok_or_else(denied)?;
        let offset = params
            .get("offset")
            .and_then(crate::js_semantics::safe_u64)
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n <= bytes.len())
            .ok_or(BrokerError::Invalid("output offset"))?;
        let length = params
            .get("length")
            .and_then(crate::js_semantics::safe_u64)
            .filter(|n| *n <= 262_144)
            .ok_or(BrokerError::Invalid("output length"))? as usize;
        Ok(json!({"base64":STANDARD.encode(&bytes[offset..bytes.len().min(offset+length)])}))
    }
    pub async fn spawn(&mut self, params: &Value, deadline: Instant) -> Result<Value, BrokerError> {
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        let argv: Vec<String> = serde_json::from_value(params["argv"].clone())
            .map_err(|_| BrokerError::Invalid("argv"))?;
        validate_argv(&argv)?;
        let ms = params
            .get("timeoutMs")
            .and_then(crate::js_semantics::safe_u64)
            .filter(|n| (1..=1_800_000).contains(n))
            .ok_or(BrokerError::Invalid("timeoutMs"))?;
        if self.cleanup_failed {
            return Err(BrokerError::Effect("provider cleanup unverified".into()));
        }
        if params.as_object().is_none_or(|p| {
            p.keys()
                .any(|k| !["argv", "timeoutMs", "env", "cwd", "stdin"].contains(&k.as_str()))
        }) {
            return Err(BrokerError::Invalid("provider command override"));
        }
        let index = self
            .pins
            .iter()
            .position(|p| p.command.matches(params, ms))
            .ok_or_else(denied)?;
        if let Some(mode) = self.pins[index].command.mode
            && !self.used.insert(mode)
        {
            return Err(denied());
        }
        self.clear_output();
        let pin = &self.pins[index];
        let Some(image) = &pin.executable else {
            return Ok(
                json!({"code":127,"stdout":"","stderr":format!("{} not found",argv[0]),"timedOut":false}),
            );
        };
        image.check()?;
        if let Some(cwd) = &pin.cwd {
            cwd.check()?;
        }
        let mut env = if pin.command.has_context() {
            pin.command.env.clone().unwrap_or_default()
        } else {
            minimal_environment(&self.environment, &argv[0])
        };
        let mut secrets = vec![];
        for (key, reference) in pin.command.secret_env.iter().flatten() {
            let secret =
                tokio::time::timeout_at(deadline.into(), self.credentials.resolve(reference))
                    .await
                    .map_err(|_| BrokerError::Timeout)??
                    .filter(|s| !s.is_empty() && !s.contains('\0'))
                    .ok_or_else(denied)?;
            env.insert(key.clone(), secret.clone());
            secrets.push(secret);
        }
        image.check()?;
        if let Some(cwd) = &pin.cwd {
            cwd.check()?;
        }
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        let mode = pin.command.mode;
        if matches!(
            mode,
            Some(
                crate::SpawnMode::PrepareBundle
                    | crate::SpawnMode::PrepareRecover
                    | crate::SpawnMode::BinaryUpload
                    | crate::SpawnMode::StartInput
            )
        ) {
            env = self.environment.clone();
        }
        let codex = mode == Some(crate::SpawnMode::CodexLive);
        let input_bytes = if codex {
            Some(crate::spawn_spec::CODEX_REQUEST.as_bytes().to_vec())
        } else {
            pin.command
                .input
                .clone()
                .or_else(|| pin.command.stdin.as_ref().map(|s| s.as_bytes().to_vec()))
        };
        let mut command = Command::new(&image.canonical);
        command
            .args(&argv[1..])
            .env_clear()
            .envs(env)
            .stdin(if input_bytes.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        if let Some(cwd) = &pin.cwd {
            command.current_dir(&cwd.canonical);
        }
        let mut child = OwnedChild(
            command
                .spawn()
                .map_err(|_| BrokerError::Effect("provider could not be started".into()))?,
        );
        let mut input = child.stdin.take();
        let mut stdout = child.stdout.take().ok_or_else(denied)?;
        let mut stderr = child.stderr.take().ok_or_else(denied)?;
        let (codex_close, mut codex_closed) = tokio::sync::oneshot::channel::<()>();
        let mut codex_close = Some(codex_close);
        let end = deadline.min(Instant::now() + Duration::from_millis(ms));
        let input_work = async {
            if let Some(mut stream) = input.take() {
                if mode == Some(crate::SpawnMode::BinaryUpload) {
                    for chunk in input_bytes.as_deref().unwrap_or_default().chunks(65_535) {
                        stream
                            .write_all(STANDARD.encode(chunk).as_bytes())
                            .await
                            .map_err(|_| BrokerError::Effect("remote host input failed".into()))?;
                    }
                } else {
                    stream
                        .write_all(input_bytes.as_deref().unwrap_or_default())
                        .await
                        .map_err(|_| BrokerError::Effect("provider input failed".into()))?;
                }
                if codex {
                    let _ = (&mut codex_closed).await;
                }
                stream
                    .shutdown()
                    .await
                    .map_err(|_| BrokerError::Effect("provider input failed".into()))?;
            }
            Ok::<_, BrokerError>(())
        };
        tokio::pin!(input_work);
        let (mut out, mut err) = (vec![], vec![]);
        let (mut out_buffer, mut err_buffer) = (vec![0; 65536], vec![0; 65536]);
        let (mut out_closed, mut err_closed, mut input_closed) = (false, false, false);
        let mut status = None;
        let mut response = Vec::new();
        let mut timed_out = false;
        let mut drain = None;
        let result: Result<(), BrokerError> = loop {
            if status.is_some() && out_closed && err_closed {
                break Ok(());
            }
            let next_deadline = drain
                .unwrap_or(end)
                .min(if timed_out { deadline } else { end });
            tokio::select! {
                biased;
                wait=child.wait(), if status.is_none() => {
                    match wait { Ok(value)=>{status=Some(value);drain=Some(Instant::now()+Duration::from_millis(100));},Err(_)=>break Err(BrokerError::Effect("provider wait failed".into())) }
                }
                read=stdout.read(&mut out_buffer), if !out_closed => {
                    match read {Ok(0)=>out_closed=true,Ok(n)=>{if out.len()+n>if codex {64_000} else {1_048_576} {break Err(BrokerError::Invalid("provider output exceeds limit"));}out.extend_from_slice(&out_buffer[..n]);
                        if codex && codex_close.is_some() {
                            response.extend_from_slice(&out_buffer[..n]);
                            while let Some(end)=response.iter().position(|b|*b==b'\n') {
                                if serde_json::from_slice::<Value>(&response[..end]).is_ok_and(|v|v["id"].as_f64()==Some(2.0))
                                    && let Some(close)=codex_close.take() { let _=close.send(()); }
                                response.drain(..=end);
                            }
                        }},Err(_)=>break Err(BrokerError::Effect("provider output failed".into()))}
                }
                read=stderr.read(&mut err_buffer), if !err_closed => {
                    match read {Ok(0)=>err_closed=true,Ok(n)=>{if err.len()+n>1_048_576 {break Err(BrokerError::Invalid("provider output exceeds limit"));}err.extend_from_slice(&err_buffer[..n]);},Err(_)=>break Err(BrokerError::Effect("provider output failed".into()))}
                }
                written=&mut input_work, if !input_closed => {if let Err(error)=written {break Err(error);} input_closed=true;}
                _=tokio::time::sleep_until(next_deadline.into()) => {
                    if drain.is_some() {
                        // The reactor may not have delivered EOF readiness before a due timer
                        // under load. Check the owned nonblocking descriptors themselves before
                        // attributing retained pipes to a descendant.
                        out_closed = out_closed || drain_ready(&stdout,&mut out)?;
                        err_closed = err_closed || drain_ready(&stderr,&mut err)?;
                        if status.is_some()&&out_closed&&err_closed {break Ok(());}
                        self.cleanup_failed = true;
                        break Err(BrokerError::Effect("provider descendant retained output pipes; cleanup unverified".into()));
                    }
                    if Instant::now()>=deadline {break Err(BrokerError::Timeout);}
                    timed_out=true;
                    if let Err(error)=terminate(&mut child).await {break Err(error);}
                    status=child.try_wait().map_err(|_|denied())?;
                    drain=Some(Instant::now()+Duration::from_millis(100));
                }
            }
        };
        if let Err(error) = result {
            terminate(&mut child).await?;
            return Err(error);
        }
        let code = status.and_then(|s| s.code()).unwrap_or(1);
        if pin.command.suppress_output {
            return Ok(json!({"code":code,"stdout":"","stderr":"","timedOut":timed_out}));
        }
        if secrets.iter().any(|s| {
            [&out, &err]
                .iter()
                .any(|bytes| bytes.windows(s.len()).any(|w| w == s.as_bytes()))
        }) {
            return Err(AuthorityError::Denied(
                "provider output exposed an injected credential".into(),
            )
            .into());
        }
        if let Some(paths) = &pin.command.capture {
            let capture = self.capture.as_mut().ok_or_else(denied)?;
            publish_capture(capture, paths, [&out, &err], deadline)?;
        }
        let inline = json!({"code":code,"stdout":String::from_utf8_lossy(&out),"stderr":String::from_utf8_lossy(&err),"timedOut":timed_out});
        if serde_json::to_vec(&inline)
            .map_err(|_| BrokerError::Invalid("provider output"))?
            .len()
            <= 768 * 1024
        {
            return Ok(inline);
        }
        let out_handle = uuid::Uuid::new_v4().to_string();
        let err_handle = uuid::Uuid::new_v4().to_string();
        self.output.insert(out_handle.clone(), out);
        self.output.insert(err_handle.clone(), err);
        Ok(
            json!({"code":code,"output":{"stdout":out_handle,"stderr":err_handle},"timedOut":timed_out}),
        )
    }
}
impl Drop for NativeProcess {
    fn drop(&mut self) {
        self.clear_output();
    }
}
fn drain_ready(stream: &impl std::os::fd::AsFd, bytes: &mut Vec<u8>) -> Result<bool, BrokerError> {
    let mut buffer = vec![0; 65_536];
    loop {
        match nix::unistd::read(stream, &mut buffer) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                if bytes.len() + n > 1_048_576 {
                    return Err(BrokerError::Invalid("provider output exceeds limit"));
                }
                bytes.extend_from_slice(&buffer[..n]);
            }
            Err(nix::errno::Errno::EAGAIN) => return Ok(false),
            Err(nix::errno::Errno::EINTR) => {}
            Err(_) => return Err(BrokerError::Effect("provider output failed".into())),
        }
    }
}
/// Capture publishes only while the owning call is live, as TypeScript `writeOwnerBytes` does.
fn publish_capture(
    capture: &mut crate::NativeWrite,
    paths: &crate::SpawnCapture,
    [out, err]: [&[u8]; 2],
    deadline: Instant,
) -> Result<(), BrokerError> {
    let live = || {
        if Instant::now() >= deadline {
            Err(AuthorityError::Expired.into())
        } else {
            Ok(())
        }
    };
    capture.write_bytes_owned(&paths.stdout, out, live)?;
    capture.write_bytes_owned(&paths.stderr, err, live)?;
    Ok(())
}
pub(crate) async fn terminate(child: &mut Child) -> Result<(), BrokerError> {
    terminate_with_grace(child, Duration::from_millis(100)).await
}
pub(crate) async fn terminate_with_grace(
    child: &mut Child,
    grace: Duration,
) -> Result<(), BrokerError> {
    // Never signal a reused PID after the owned leader has exited.
    if child.try_wait().map_err(|_| denied())?.is_some() {
        return Ok(());
    }
    let pid = child
        .id()
        .and_then(|n| i32::try_from(n).ok())
        .ok_or_else(denied)?;
    let group = nix::unistd::Pid::from_raw(-pid);
    let _ = nix::sys::signal::kill(group, nix::sys::signal::Signal::SIGTERM);
    if timeout(grace, child.wait()).await.is_err() {
        let _ = nix::sys::signal::kill(group, nix::sys::signal::Signal::SIGKILL);
        timeout(Duration::from_secs(2), child.wait())
            .await
            .map_err(|_| BrokerError::Effect("provider cleanup unverified".into()))?
            .map_err(|_| denied())?;
    }
    Ok(())
}
fn validate_argv(argv: &[String]) -> Result<(), BrokerError> {
    if argv.is_empty()
        || argv.len() > 32
        || argv
            .iter()
            .any(|s| s.contains('\0') || crate::js_semantics::utf16_len(s) > 4096)
        || argv[0] == "*"
        || Path::new(&argv[0]).is_absolute()
    {
        return Err(BrokerError::Invalid("provider argv"));
    }
    Ok(())
}
pub fn minimal_environment(
    env: &HashMap<String, String>,
    executable: &str,
) -> HashMap<String, String> {
    let base = [
        "HOME",
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ];
    let network = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "ssl_cert_file",
        "ssl_cert_dir",
        "node_extra_ca_certs",
    ];
    let extra: &[&str] = match executable {
        "notify-send" => &[
            "DBUS_SESSION_BUS_ADDRESS",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
        ],
        "arkcli" => &[
            "ARK_API_KEY",
            "ARK_BASE_URL",
            "ARK_PROFILE",
            "ARK_PROJECT_NAME",
            "ARK_REGION",
        ],
        _ => &[],
    };
    env.iter()
        .filter(|(k, _)| {
            base.contains(&k.as_str())
                || extra.contains(&k.as_str())
                || (["arkcli", "opencode"].contains(&executable) && network.contains(&k.as_str()))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}
#[cfg(test)]
mod tests;
