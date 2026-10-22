//! Fixed Root-owned update-helper process authority for paired cores.
use std::{
    io,
    path::{Path, PathBuf},
};

struct Request {
    path: PathBuf,
    sha256: String,
    version: String,
    started_at_ms: u64,
}
fn denied() -> io::Error {
    io::Error::other("native helper unavailable")
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn request(bytes: &[u8], home: &Path) -> io::Result<Request> {
    if bytes.is_empty() || bytes.len() > 8192 {
        return Err(denied());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| denied())?;
    let object = value.as_object().ok_or_else(denied)?;
    if object.len() != 5 || value["schema"] != 1 {
        return Err(denied());
    }
    // Diagnostic only: never an authority, expiry, or deadline input.
    let started_at_ms = value["startedAtMs"]
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(denied)?;
    let path = value["path"].as_str().ok_or_else(denied)?;
    let digest = value["sha256"]
        .as_str()
        .filter(|v| hex64(v))
        .ok_or_else(denied)?;
    let version = value["version"]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
                && v.split('.').take(3).count() == 3
                && v.as_bytes()[0].is_ascii_digit()
        })
        .ok_or_else(denied)?;
    let path = PathBuf::from(path);
    if path
        .to_str()
        .is_none_or(|v| v.len() > 4096 || v.contains('\0'))
        || !path.is_absolute()
        || path.components().any(|p| {
            !matches!(
                p,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
    {
        return Err(denied());
    }
    let normalized: PathBuf = path.components().collect();
    if normalized.as_os_str() != path.as_os_str() {
        return Err(denied());
    }
    let relative = path.strip_prefix(home).map_err(|_| denied())?;
    let parts: Vec<_> = relative.iter().filter_map(|s| s.to_str()).collect();
    if !(parts.len() == 5
        && parts[0] == "desktop-updates"
        && parts[1] == "native"
        && hex64(parts[2])
        && uuid(parts[3])
        && parts[4] == "pacer-update-helper"
        || parts.len() == 6
            && parts[0] == "desktop-updates"
            && parts[1] == "native"
            && hex64(parts[2])
            && parts[3] == "commands"
            && uuid(parts[4])
            && parts[5] == "pacer-update-helper")
    {
        return Err(denied());
    }
    if home.join(relative).as_os_str() != path.as_os_str() || path.to_string_lossy().contains("//")
    {
        return Err(denied());
    }
    Ok(Request {
        started_at_ms,
        path,
        sha256: digest.into(),
        version: version.into(),
    })
}

#[cfg(test)]
#[path = "native_helper_tests.rs"]
mod tests;
fn cdhash(bytes: &[u8]) -> io::Result<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| denied())?;
    let values: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("CDHash="))
        .collect();
    if values.len() != 1
        || values[0].len() != 40
        || !values[0].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    Ok(values[0].to_ascii_lowercase())
}

use super::native_helper_diagnostics::{Diagnostics, Event, Stage};
use super::native_trust::{NativeRole, NativeTrust, ProcessDetails, ProcessIdentity};
struct Trace<'a> {
    diagnostics: &'a Diagnostics,
    stage: Stage,
}
impl Trace<'_> {
    fn mark(&mut self, stage: Stage) {
        self.stage = stage;
        self.diagnostics.record(stage, Event::Enter);
    }
    fn failed(&self) {
        self.diagnostics.record(self.stage, Event::Failed);
    }
}
impl Drop for Trace<'_> {
    fn drop(&mut self) {
        self.diagnostics.record(self.stage, Event::End);
    }
}
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata, OpenOptions},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            net::UnixStream,
        },
    },
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::Semaphore,
};

fn snapshot(m: &Metadata) -> (u64, u64, u64, u32, u32, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.uid(),
        m.mode(),
        m.nlink(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
struct HeldFile {
    file: File,
    path: PathBuf,
    before: Metadata,
    digest: String,
}
impl HeldFile {
    fn open(path: &Path, cap: u64, executable: bool) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
            .open(path)?;
        let before = file.metadata()?;
        if !before.is_file()
            || before.uid() != nix::unistd::getuid().as_raw()
            || before.nlink() != 1
            || before.mode() & 0o077 != 0
            || before.len() > cap
            || executable && before.mode() & 0o100 == 0
            || path.canonicalize()? != path
        {
            return Err(denied());
        }
        let mut result = Self {
            file,
            path: path.into(),
            before,
            digest: String::new(),
        };
        result.digest = result.hash(cap)?;
        result.recheck()?;
        Ok(result)
    }
    fn hash(&self, cap: u64) -> io::Result<String> {
        use std::os::unix::fs::FileExt;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut offset = 0;
        loop {
            let n = self.file.read_at(&mut buffer, offset)?;
            if n == 0 {
                break;
            }
            offset += n as u64;
            if offset > cap {
                return Err(denied());
            }
            hash.update(&buffer[..n]);
        }
        Ok(hex::encode(hash.finalize()))
    }
    fn recheck(&self) -> io::Result<()> {
        let held = self.file.metadata()?;
        let linked = self.path.symlink_metadata()?;
        if snapshot(&held) != snapshot(&self.before)
            || snapshot(&linked) != snapshot(&self.before)
            || linked.file_type().is_symlink()
            || self.path.canonicalize()? != self.path
        {
            return Err(denied());
        }
        Ok(())
    }
    fn bytes(&self, cap: u64) -> io::Result<Vec<u8>> {
        use std::os::unix::fs::FileExt;
        let mut bytes = vec![0; usize::try_from(self.before.len()).map_err(|_| denied())?];
        if bytes.len() as u64 > cap {
            return Err(denied());
        }
        self.file.read_exact_at(&mut bytes, 0)?;
        self.recheck()?;
        Ok(bytes)
    }
}
fn private_directories(home: &Path, path: &Path) -> io::Result<Vec<(PathBuf, Metadata)>> {
    let mut result = Vec::new();
    let mut current = home.to_path_buf();
    let relative = path
        .parent()
        .ok_or_else(denied)?
        .strip_prefix(home)
        .map_err(|_| denied())?;
    for part in std::iter::once(None).chain(relative.iter().map(Some)) {
        if let Some(part) = part {
            current.push(part);
        }
        let metadata = current.symlink_metadata()?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != nix::unistd::getuid().as_raw()
            || metadata.mode() & 0o077 != 0
            || current.canonicalize()? != current
        {
            return Err(denied());
        }
        result.push((current.clone(), metadata));
    }
    Ok(result)
}
struct Asset {
    helper: HeldFile,
    manifest: Option<HeldFile>,
    directories: Vec<(PathBuf, Metadata)>,
}
impl Asset {
    fn verify(request: &Request, home: &Path) -> io::Result<Self> {
        let directories = private_directories(home, &request.path)?;
        let helper = HeldFile::open(&request.path, 128 * 1024 * 1024, true)?;
        if helper.digest != request.sha256 {
            return Err(denied());
        }
        let parent = request.path.parent().ok_or_else(denied)?;
        let parts: Vec<_> = request
            .path
            .strip_prefix(home)
            .map_err(|_| denied())?
            .iter()
            .collect();
        let manifest = if parts.len() == 5 {
            let paths = [
                parent.join("prepared.json"),
                parent.join("adoption-prepared.json"),
            ];
            let present: Vec<_> = paths.iter().filter(|p| p.exists()).collect();
            if present.len() != 1 {
                return Err(denied());
            }
            let held = HeldFile::open(present[0], 1024 * 1024, false)?;
            let value: serde_json::Value =
                serde_json::from_slice(&held.bytes(1024 * 1024)?).map_err(|_| denied())?;
            let target = if present[0]
                .file_name()
                .is_some_and(|n| n == "adoption-prepared.json")
            {
                &value["source"]["target"]
            } else {
                &value["target"]
            };
            let installation = parts[2].to_str().ok_or_else(denied)?;
            let transaction = parts[3].to_str().ok_or_else(denied)?;
            let journal = HeldFile::open(&parent.join("journal.json"), 1024 * 1024, false)?;
            let journal_value: serde_json::Value =
                serde_json::from_slice(&journal.bytes(1024 * 1024)?).map_err(|_| denied())?;
            if value["schema"] != 1
                || value["binding"]["installationId"] != installation
                || value["binding"]["transactionId"] != transaction
                || target["id"] != installation
                || target["pacerHome"].as_str() != home.to_str()
                || target["version"] != request.version
                || value["recoveryJob"]["helper"]["relativePath"] != "pacer-update-helper"
                || value["recoveryJob"]["helper"]["sha256"] != request.sha256
                || journal_value["manifestSha256"] != held.digest
            {
                return Err(denied());
            }
            Some(held)
        } else {
            None
        };
        Ok(Self {
            helper,
            manifest,
            directories,
        })
    }
    fn recheck(&self) -> io::Result<()> {
        for (path, before) in &self.directories {
            let now = path.symlink_metadata()?;
            if !now.is_dir()
                || now.file_type().is_symlink()
                || now.dev() != before.dev()
                || now.ino() != before.ino()
                || now.uid() != before.uid()
                || now.mode() != before.mode()
                || path.canonicalize()? != *path
            {
                return Err(denied());
            }
        }
        self.helper.recheck()?;
        if self.helper.hash(128 * 1024 * 1024)? != self.helper.digest {
            return Err(denied());
        }
        if let Some(manifest) = &self.manifest {
            manifest.recheck()?;
            if manifest.hash(1024 * 1024)? != manifest.digest {
                return Err(denied());
            }
        }
        Ok(())
    }
}
async fn image_hash(path: &Path) -> io::Result<String> {
    let mut child = Command::new("/usr/bin/codesign")
        .args(["--display", "--verbose=4"])
        .arg(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let out = child.stdout.take().ok_or_else(denied)?;
    let err = child.stderr.take().ok_or_else(denied)?;
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let mut out = out.take(65537);
        let mut err = err.take(65537);
        let (a, b) = tokio::join!(out.read_to_end(&mut output), err.read_to_end(&mut errors));
        a?;
        b?;
        if output.len() > 65536 || errors.len() > 65536 {
            return Err(denied());
        }
        if !child.wait().await?.success() {
            return Err(denied());
        }
        output.extend_from_slice(&errors);
        cdhash(&output)
    })
    .await
    .map_err(|_| denied())?
}

pub struct Broker {
    pub trust: NativeTrust,
    pub home: PathBuf,
    pub user_home: PathBuf,
    pub port: u16,
    pub root: ProcessIdentity,
    pub front: PathBuf,
    pub generation: ProcessDetails,
    pub slots: Arc<Semaphore>,
}
fn send_rights(socket: &impl AsRawFd, bytes: &[u8], fds: &[i32]) -> io::Result<usize> {
    use nix::sys::socket::{ControlMessage, MsgFlags, UnixAddr, sendmsg};
    sendmsg::<UnixAddr>(
        socket.as_raw_fd(),
        &[std::io::IoSlice::new(bytes)],
        &[ControlMessage::ScmRights(fds)],
        MsgFlags::empty(),
        None,
    )
    .map_err(Into::into)
}
impl Broker {
    async fn spawn(
        &self,
        request: Request,
        permit: tokio::sync::OwnedSemaphorePermit,
        channel: &tokio::net::UnixStream,
        trace: &mut Trace<'_>,
    ) -> io::Result<()> {
        trace.mark(Stage::GenerationBefore);
        self.trust.verify_generation(&self.generation)?;
        trace.mark(Stage::Asset);
        let asset = Asset::verify(&request, &self.home)?;
        trace.mark(Stage::StaticRole);
        self.trust
            .verify_static(&request.path, NativeRole::Helper)?;
        trace.mark(Stage::ImageMetadata);
        let hash = image_hash(&request.path).await?;
        trace.mark(Stage::StaticImage);
        self.trust.verify_helper_image(None, &request.path, &hash)?;
        trace.mark(Stage::AssetBefore);
        asset.recheck()?;
        trace.mark(Stage::GenerationSpawn);
        self.trust.verify_generation(&self.generation)?;
        trace.mark(Stage::Spawn);
        let child = Command::new(&request.path)
            .arg("--ota-pipe")
            .env_clear()
            .env("HOME", &self.user_home)
            .env("PACER_HOME", &self.home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(false)
            .spawn()?;
        let mut guard = Unhanded(Some(child));
        let child = guard.0.as_mut().ok_or_else(denied)?;
        trace.mark(Stage::DynamicImage);
        self.trust
            .verify_helper_image(Some(child), &request.path, &hash)?;
        trace.mark(Stage::AssetAfter);
        asset.recheck()?;
        trace.mark(Stage::GenerationHandoff);
        self.trust.verify_generation(&self.generation)?;
        trace.mark(Stage::Bootstrap);
        let pid = child.id().ok_or_else(denied)?;
        let value = serde_json::to_vec(
            &serde_json::json!({"schema":1,"kind":"helper-bootstrap","home":self.home,"port":self.port,"service":{"pid":self.root.pid,"bootId":self.root.boot_id,"birth":self.root.birth},"executable":self.front}),
        )?;
        let mut input = child.stdin.take().ok_or_else(denied)?;
        tokio::time::timeout(Duration::from_secs(5), async {
            input.write_all(&(value.len() as u32).to_be_bytes()).await?;
            input.write_all(&value).await
        })
        .await
        .map_err(|_| denied())??;
        trace.mark(Stage::Pipes);
        let input = input.into_owned_fd()?;
        let output = child.stdout.take().ok_or_else(denied)?.into_owned_fd()?;
        let (exit, remote) = UnixStream::pair()?;
        socket2::SockRef::from(&exit).set_nosigpipe(true)?;
        let remote: OwnedFd = remote.into();
        let mut response = [b'H', 0, 0, 0, 0];
        response[1..].copy_from_slice(&pid.to_be_bytes());
        trace.mark(Stage::Handoff);
        let sent = send_rights(
            channel,
            &response,
            &[input.as_raw_fd(), output.as_raw_fd(), remote.as_raw_fd()],
        );
        match &sent {
            Ok(0) => {
                trace.diagnostics.record(Stage::Handoff, Event::WriteError);
                trace.diagnostics.record(Stage::Handoff, Event::WriteZero);
                return Err(denied());
            }
            Err(error) => {
                trace.diagnostics.record(Stage::Handoff, Event::WriteError);
                trace
                    .diagnostics
                    .record(Stage::Handoff, Event::write_failure(error));
                return Err(denied());
            }
            Ok(_) => { /* Any positive transfer may have delivered command authority. */ }
        }
        let child = guard.0.take().ok_or_else(denied)?;
        tokio::spawn(async move {
            let _permit = permit;
            reap(child, exit).await;
        });
        if sent.ok() != Some(5) {
            trace
                .diagnostics
                .record(Stage::Handoff, Event::HandoffUncertain);
            return Err(denied());
        }
        trace.diagnostics.record(Stage::Handoff, Event::Handoff);
        Ok(())
    }
    pub async fn run(self, channel: UnixStream) {
        let diagnostics = Diagnostics::new(&self.home, self.root.pid, self.generation.process.pid);
        let mut trace = Trace {
            diagnostics: &diagnostics,
            stage: Stage::Channel,
        };
        trace.mark(Stage::Channel);
        // NativeContext owns this limit across all core generations. Handed
        // reapers retain their permit until the actual helper process exits.
        let slots = self.slots.clone();
        if channel.set_nonblocking(true).is_err() {
            trace.failed();
            return;
        }
        let socket = match tokio::net::UnixStream::from_std(channel) {
            Ok(s) => s,
            Err(_) => {
                trace.failed();
                return;
            }
        };
        loop {
            trace.mark(Stage::ReadFrame);
            let body = match read_request_observed(&socket, Some(&diagnostics)).await {
                Ok(Some(b)) => b,
                Ok(None) => return,
                Err(_) => {
                    trace.failed();
                    return;
                }
            };
            let result = async {
                trace.mark(Stage::Request);
                let request = request(&body, &self.home)?;
                diagnostics.request_started(request.started_at_ms);
                trace.mark(Stage::Capacity);
                let permit = slots.clone().try_acquire_owned().map_err(|_| denied())?;
                tokio::time::timeout(
                    Duration::from_secs(10),
                    self.spawn(request, permit, &socket, &mut trace),
                )
                .await
                .map_err(|_| denied())?
            }
            .await;
            if result.is_err() {
                trace.failed();
                match socket.try_write(&[b'E', 0, 0, 0, 0]) {
                    Ok(5) => {}
                    Ok(_) => {
                        diagnostics.record(trace.stage, Event::WriteError);
                        diagnostics.record(trace.stage, Event::WriteShort);
                    }
                    Err(error) => {
                        diagnostics.record(trace.stage, Event::WriteError);
                        diagnostics.record(trace.stage, Event::write_failure(&error));
                    }
                }
                return;
            }
        }
    }
}
#[cfg(test)]
async fn read_request(socket: &tokio::net::UnixStream) -> io::Result<Option<Vec<u8>>> {
    read_request_observed(socket, None).await
}
async fn read_request_observed(
    socket: &tokio::net::UnixStream,
    diagnostics: Option<&Diagnostics>,
) -> io::Result<Option<Vec<u8>>> {
    let mut first = [0];
    loop {
        socket.readable().await?;
        match receive(socket, &mut first) {
            Ok(0) => return Ok(None),
            Ok(_) => {
                if let Some(diagnostics) = diagnostics {
                    diagnostics.record(Stage::ReadFirstByte, Event::Enter);
                }
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
            Err(e) => return Err(e),
        }
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut header = [first[0], 0, 0, 0];
        read_exact(socket, &mut header[1..]).await?;
        let size = u32::from_be_bytes(header) as usize;
        if size == 0 || size > 8192 {
            return Err(denied());
        }
        let mut bytes = vec![0; size];
        read_exact(socket, &mut bytes).await?;
        Ok(Some(bytes))
    })
    .await
    .map_err(|_| denied())?
}
async fn read_exact(socket: &tokio::net::UnixStream, mut bytes: &mut [u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        socket.readable().await?;
        match receive(socket, bytes) {
            Ok(0) => return Err(denied()),
            Ok(n) => {
                bytes = &mut bytes[n..];
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
async fn reap(mut child: Child, exit: UnixStream) {
    use std::os::unix::process::ExitStatusExt;
    if exit.set_nonblocking(true).is_err() {
        let _ = child.wait().await;
        return;
    }
    let Ok(mut exit) = tokio::net::UnixStream::from_std(exit) else {
        let _ = child.wait().await;
        return;
    };
    let mut byte = [0];
    let status = tokio::select! {
        status=child.wait()=>status,
        received=exit.read(&mut byte)=>{
            if matches!(received,Ok(1)) && byte==*b"A" {
                // Preserve the legacy helper abort signal. Child remains owned
                // and unreaped here, so its PID cannot identify a replacement.
                if let Some(pid)=child.id().and_then(|pid|i32::try_from(pid).ok()) {
                    let _=nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid),nix::sys::signal::Signal::SIGTERM);
                }
            }
            // Handed helper may have durable authorization: EOF never kills it.
            child.wait().await
        }
    };
    if let Ok(status) = status {
        let value = status
            .code()
            .unwrap_or_else(|| -status.signal().unwrap_or(1));
        let _ = exit.write_all(&value.to_be_bytes()).await;
    }
}

struct Unhanded(Option<Child>);
impl Drop for Unhanded {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.start_kill();
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

fn receive(socket: &tokio::net::UnixStream, bytes: &mut [u8]) -> io::Result<usize> {
    use nix::sys::socket::{ControlMessageOwned, MsgFlags, UnixAddr, recvmsg};
    socket.try_io(tokio::io::Interest::READABLE, || {
        // Darwin may install more rights than an undersized control buffer
        // describes. Legal sends contain at most254; reserve1024 so every
        // installed right remains visible and can be closed on rejection.
        let mut storage = nix::cmsg_space!([i32; 1024]);
        let mut vectors = [std::io::IoSliceMut::new(bytes)];
        let message = recvmsg::<UnixAddr>(
            socket.as_raw_fd(),
            &mut vectors,
            Some(&mut storage),
            MsgFlags::MSG_DONTWAIT,
        )
        .map_err(io::Error::from)?;
        let mut forbidden = message
            .flags
            .intersects(MsgFlags::MSG_CTRUNC | MsgFlags::MSG_TRUNC);
        for control in message.cmsgs().map_err(io::Error::from)? {
            forbidden = true;
            if let ControlMessageOwned::ScmRights(fds) = control {
                for fd in fds {
                    let _ = nix::unistd::close(fd);
                }
            }
        }
        if forbidden {
            return Err(denied());
        }
        Ok(message.bytes)
    })
}
