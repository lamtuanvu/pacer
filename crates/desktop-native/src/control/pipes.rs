//! Verified helper pipe factory for the native front door (port of
//! `createNativePipeFactory` in `src/update/desktop/native-provider.ts`).
//!
//! The factory advertises the helper command set the desktop's adapters
//! exercise over the pipe, then opens a verified byte pipe to a freshly
//! installed `pacer-update-helper`. This desk walks the same command-set
//! and direct-spawn path as the desktop reference; the connection-level
//! handoff broker (`native_helper::Broker`) remains the socket surface.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use pacer_desktop_update::adapter::{AdapterError, NativeSessionRef, PipeFactory, VerifiedPipe};
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// `ownProcessIdentity`-style identity of the freshly spawned helper.
pub fn helper_identity(pid: u32, executable: &Path) -> (String, String, String) {
    (
        pid.to_string(),
        executable.display().to_string(),
        "helper".to_string(),
    )
}

fn denied() -> CoreError {
    CoreError::new(Code::NotAllowed, "Native helper pipe could not be verified")
        .hint("Retain the transaction for authenticated recovery.")
}

/// The verified native install session a pipe could be opened for. Kept so the
/// factory's `open` surface documents which session fields the caller must
/// award before a pipe is created.
pub struct PipeSession {
    pub installation: Value,
    pub alive: bool,
    /// `appPath` of the bundled helper source.
    pub app_path: PathBuf,
}

/// A verified byte pipe to a helper process. Wraps the helper's stdin and
/// stdout, tracking the reported identity for validation.
pub struct NativePipe {
    identity: (String, String, String),
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    aborted: bool,
}

impl NativePipe {
    /// Take ownership of a freshly spawned helper.
    pub fn new(identity: (String, String, String), mut child: Child) -> Option<Self> {
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        Some(Self {
            identity,
            child,
            stdin,
            stdout,
            aborted: false,
        })
    }

    /// The child's pid, for verification and cleanup.
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Whether `abort` has already signalled termination.
    pub fn is_aborted(&self) -> bool {
        self.aborted
    }

    /// Wait for the helper to exit.
    pub async fn exited(&mut self) -> std::io::Result<()> {
        let _ = self.child.wait().await?;
        Ok(())
    }
}

impl VerifiedPipe for NativePipe {
    fn identity(&self) -> (&str, &str, &str) {
        (&self.identity.0, &self.identity.1, &self.identity.2)
    }

    fn send(
        &mut self,
        frame: &[u8],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + '_>> {
        let frame = frame.to_vec();
        Box::pin(async move {
            if self.aborted {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "helper pipe aborted",
                ));
            }
            self.stdin.write_all(&frame).await?;
            self.stdin.flush().await
        })
    }

    fn recv(
        &mut self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = std::io::Result<Option<Vec<u8>>>> + Send + '_>,
    > {
        Box::pin(async move {
            // A bounded read of one frame chunk: read the 4-byte length
            // prefix then the body. EOF before a full header is a clean
            // close.
            let mut header = [0u8; 4];
            let mut read = 0usize;
            while read < 4 {
                let n = self.stdout.read(&mut header[read..]).await?;
                if n == 0 {
                    return Ok(if read == 0 {
                        None
                    } else {
                        Some(header[..read].to_vec())
                    });
                }
                read += n;
            }
            let length = u32::from_be_bytes(header) as usize;
            if length > 128 * 1024 * 1024 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "helper frame exceeds bound",
                ));
            }
            let mut body = vec![0u8; length];
            self.stdout.read_exact(&mut body).await?;
            let mut frame = Vec::with_capacity(4 + length);
            frame.extend_from_slice(&header);
            frame.extend_from_slice(&body);
            Ok(Some(frame))
        })
    }

    fn abort(&mut self) {
        if self.aborted {
            return;
        }
        self.aborted = true;
        let _ = self.child.start_kill();
    }
}

/// The command set the desktop adapters exercise over the pipe.
pub fn capabilities() -> Vec<&'static str> {
    vec![
        "adopt",
        "check",
        "download",
        "install",
        "recover",
        "recover-adoption",
    ]
}

/// Prepare the fresh helper command directory: `desktop-updates/native/
/// <installationId>/commands/<uuid>`.
fn command_directory(home: &Path, installation_id: &str) -> Result<PathBuf, CoreError> {
    let mut dir = home.join("desktop-updates");
    for part in [
        "native",
        installation_id,
        "commands",
        &uuid::Uuid::new_v4().to_string(),
    ] {
        dir = dir.join(part);
        match std::fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(denied()),
        }
        let meta = std::fs::symlink_metadata(&dir).map_err(|_| denied())?;
        let uid = nix::unistd::getuid().as_raw();
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != uid
            || meta.mode() & 0o077 != 0
            || std::fs::canonicalize(&dir).ok().as_deref() != Some(dir.as_path())
        {
            return Err(denied());
        }
    }
    Ok(dir)
}

/// Copy the bundled helper into the fresh command directory with exclusive
/// creation and 0700 mode.
fn install_helper(source: &Path, helper: &Path) -> Result<(), CoreError> {
    let bytes = std::fs::read(source).map_err(|_| denied())?;
    if bytes.len() > 128 * 1024 * 1024 {
        return Err(denied());
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true)
        .create_new(true)
        .mode(0o700)
        .custom_flags(nix::libc::O_NOFOLLOW);
    let mut file = opts.open(helper).map_err(|_| denied())?;
    use std::io::Write;
    file.write_all(&bytes).map_err(|_| denied())?;
    file.sync_all().map_err(|_| denied())?;
    std::fs::set_permissions(helper, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| denied())?;
    Ok(())
}

/// A re-verification callback: check the awarded session before any frame is
/// exchanged over a freshly opened helper pipe.
type Reverify = Arc<dyn Fn(&NativeSessionRef) -> Result<(), CoreError> + Send + Sync>;

/// A verified pipe factory (the Rust `VerifiedPipeFactory`). Opens a
/// freshly installed `pacer-update-helper` under the pacer home and
/// reverifies against the awarded session before any frame is exchanged.
pub struct NativePipeFactory {
    home: PathBuf,
    app_path: PathBuf,
    on_reverify: Reverify,
}

impl NativePipeFactory {
    pub fn new(
        home: impl Into<PathBuf>,
        app_path: impl Into<PathBuf>,
        on_reverify: impl Fn(&NativeSessionRef) -> Result<(), CoreError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            home: home.into(),
            app_path: app_path.into(),
            on_reverify: Arc::new(on_reverify),
        }
    }

    /// The bundled helper path (`appPath/Contents/Resources/pacer-update-helper`).
    fn bundled_helper(&self) -> PathBuf {
        self.app_path
            .join("Contents")
            .join("Resources")
            .join("pacer-update-helper")
    }
}

impl PipeFactory for NativePipeFactory {
    fn open(
        &self,
        session: &NativeSessionRef,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Box<dyn VerifiedPipe>, AdapterError>>
                + Send
                + '_,
        >,
    > {
        let home = self.home.clone();
        let bundled = self.bundled_helper();
        let on_reverify = self.on_reverify.clone();
        let session_local = NativeSessionRef::new(session.installation_id.clone());
        Box::pin(async move {
            (on_reverify)(&session_local).map_err(|_| adapter_denied())?;
            let dir = command_directory(&home, &session_local.installation_id)
                .map_err(|_| adapter_denied())?;
            let helper = dir.join("pacer-update-helper");
            install_helper(&bundled, &helper).map_err(|_| adapter_denied())?;
            let child = Command::new(&helper)
                .arg("--ota-pipe")
                .env_clear()
                .env("HOME", home_dir())
                .env("PACER_HOME", &home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| adapter_denied())?;
            let pid = child.id();
            let identity = pid
                .map(|pid| helper_identity(pid, &helper))
                .ok_or_else(adapter_denied)?;
            let pipe = NativePipe::new(identity, child).ok_or_else(adapter_denied)?;
            Ok(Box::new(pipe) as Box<dyn VerifiedPipe>)
        })
    }
}

fn adapter_denied() -> AdapterError {
    AdapterError::protocol()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/pipes.rs"]
mod tests;
