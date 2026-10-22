//! Bounded private broker stage evidence; never an authority or public API.
use std::path::Path;
#[derive(Clone, Copy)]
pub enum Stage {
    Channel,
    ReadFrame,
    ReadFirstByte,
    Request,
    Capacity,
    GenerationBefore,
    Asset,
    StaticRole,
    ImageMetadata,
    StaticImage,
    AssetBefore,
    GenerationSpawn,
    Spawn,
    DynamicImage,
    AssetAfter,
    GenerationHandoff,
    Bootstrap,
    Pipes,
    Handoff,
    Receipt,
}
#[derive(Clone, Copy)]
pub enum Event {
    Enter,
    Failed,
    Handoff,
    HandoffUncertain,
    WriteError,
    WriteEpipe,
    WriteWouldBlock,
    WriteBadFd,
    WriteInvalid,
    WritePermission,
    WriteAccess,
    WriteMessageSize,
    WriteConnectionReset,
    WriteNoBuffers,
    WriteNotSocket,
    WriteInterrupted,
    WriteOther,
    WriteZero,
    WriteShort,
    CoreDiagnosticUnavailable,
    CoreDiagnosticInvalid,
    End,
}
use nix::{
    fcntl::{AtFlags, Flock, FlockArg, OFlag, openat},
    sys::stat::{Mode, fstatat, mkdirat},
};
use std::{
    fs::{File, Metadata, OpenOptions},
    io::{self, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
const CAP: u64 = 65536;
fn denied() -> io::Error {
    io::Error::other("private helper diagnostics unavailable")
}
fn identity(m: &Metadata) -> (u64, u64) {
    (m.dev(), m.ino())
}
fn private_directory(m: &Metadata) -> bool {
    m.is_dir()
        && !m.file_type().is_symlink()
        && m.uid() == nix::unistd::getuid().as_raw()
        && m.mode() & 0o7777 == 0o700
}
fn private_file(m: &Metadata) -> bool {
    m.is_file()
        && m.uid() == nix::unistd::getuid().as_raw()
        && m.nlink() == 1
        && m.mode() & 0o7777 == 0o600
}
struct Log {
    append_lock: Mutex<()>,
    home: PathBuf,
    home_file: File,
    directory: File,
    file: File,
    home_identity: (u64, u64),
    directory_identity: (u64, u64),
    file_identity: (u64, u64),
}
impl Log {
    fn open(home: &Path) -> io::Result<Self> {
        if !home.is_absolute() || home.canonicalize()?.as_os_str() != home.as_os_str() {
            return Err(denied());
        }
        let home_file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY | nix::libc::O_CLOEXEC)
            .open(home)?;
        let home_metadata = home_file.metadata()?;
        if !private_directory(&home_metadata)
            || identity(&home.symlink_metadata()?) != identity(&home_metadata)
        {
            return Err(denied());
        }
        match mkdirat(&home_file, "logs", Mode::S_IRWXU) {
            Ok(()) => {}
            Err(nix::errno::Errno::EEXIST) => {}
            Err(e) => return Err(e.into()),
        }
        let directory = File::from(openat(
            &home_file,
            "logs",
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?);
        let directory_metadata = directory.metadata()?;
        if !private_directory(&directory_metadata) {
            return Err(denied());
        }
        let file = File::from(openat(
            &directory,
            "native-helper.log",
            OFlag::O_WRONLY
                | OFlag::O_APPEND
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )?);
        let metadata = file.metadata()?;
        if !private_file(&metadata) || metadata.len() > CAP {
            return Err(denied());
        }
        let log = Self {
            append_lock: Mutex::new(()),
            home: home.into(),
            home_file,
            directory,
            file,
            home_identity: identity(&home_metadata),
            directory_identity: identity(&directory_metadata),
            file_identity: identity(&metadata),
        };
        log.check()?;
        Ok(log)
    }
    fn check(&self) -> io::Result<()> {
        let home = self.home.symlink_metadata()?;
        let held_home = self.home_file.metadata()?;
        let directory = self.directory.metadata()?;
        let linked_directory = self.home.join("logs").symlink_metadata()?;
        let file = self.file.metadata()?;
        let linked = fstatat(
            &self.directory,
            "native-helper.log",
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )?;
        if !private_directory(&home)
            || !private_directory(&held_home)
            || identity(&home) != self.home_identity
            || identity(&held_home) != self.home_identity
            || !private_directory(&directory)
            || !private_directory(&linked_directory)
            || identity(&directory) != self.directory_identity
            || identity(&linked_directory) != self.directory_identity
            || !private_file(&file)
            || identity(&file) != self.file_identity
            || linked.st_dev as u64 != file.dev()
            || linked.st_ino != file.ino()
            || linked.st_mode & nix::libc::S_IFMT != nix::libc::S_IFREG
            || linked.st_nlink != 1
            || linked.st_uid != file.uid()
            || linked.st_mode & 0o7777 != 0o600
        {
            return Err(denied());
        }
        Ok(())
    }
    fn append(&self, bytes: &[u8]) -> io::Result<()> {
        let _guard = self.append_lock.try_lock().map_err(|_| denied())?;
        // Nonblocking cross-process lock: another Root/port must not race the cap.
        let mut file = Flock::lock(self.file.try_clone()?, FlockArg::LockExclusiveNonblock)
            .map_err(|(_, e)| io::Error::from(e))?;
        self.check()?;
        if file.metadata()?.len().saturating_add(bytes.len() as u64) > CAP {
            return Ok(());
        }
        file.write_all(bytes)
    }
}
pub struct Diagnostics {
    log: Option<Log>,
    root: u32,
    core: u32,
}
impl Diagnostics {
    pub fn new(home: &Path, root: u32, core: u32) -> Self {
        Self {
            log: Log::open(home).ok(),
            root,
            core,
        }
    }
    fn append_record(&self, value: serde_json::Value) {
        let Some(log) = &self.log else { return };
        if let Ok(mut bytes) = serde_json::to_vec(&value) {
            bytes.push(b'\n');
            let _ = log.append(&bytes);
        }
    }
    pub fn core_failure(&self, stage: u8, category: u8) -> bool {
        let Some(stage) = core_stage(stage) else {
            return false;
        };
        let Some(category) = core_category(category) else {
            return false;
        };
        self.append_record(serde_json::json!({"at_ms":now_ms(),"root_pid":self.root,"core_pid":self.core,"stage":"core-helper-failure","event":"reported","core_stage":stage,"core_category":category}));
        true
    }
    pub fn request_started(&self, started_at_ms: u64) {
        let stamp = now_ms();
        let age = i64::try_from(stamp)
            .unwrap_or(i64::MAX)
            .saturating_sub(i64::try_from(started_at_ms).unwrap_or(i64::MAX));
        self.append_record(serde_json::json!({"at_ms":stamp,"root_pid":self.root,"core_pid":self.core,"stage":"request","event":"request-timing","started_at_ms":started_at_ms,"request_age_ms":age.clamp(-86_400_000,86_400_000)}));
    }
    pub fn record(&self, stage: Stage, event: Event) {
        let stamp = now_ms();
        self.append_record(serde_json::json!({"at_ms":stamp,"root_pid":self.root,"core_pid":self.core,"stage":stage.name(),"event":event.name()}));
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::ReadFrame => "read-frame",
            Self::ReadFirstByte => "read-first-byte",
            Self::Request => "request",
            Self::Capacity => "capacity",
            Self::GenerationBefore => "generation-before",
            Self::Asset => "asset",
            Self::StaticRole => "static-role",
            Self::ImageMetadata => "image-metadata",
            Self::StaticImage => "static-image",
            Self::AssetBefore => "asset-before",
            Self::GenerationSpawn => "generation-spawn",
            Self::Spawn => "spawn",
            Self::DynamicImage => "dynamic-image",
            Self::AssetAfter => "asset-after",
            Self::GenerationHandoff => "generation-handoff",
            Self::Bootstrap => "bootstrap",
            Self::Pipes => "pipes",
            Self::Handoff => "handoff",
            Self::Receipt => "receipt",
        }
    }
}
impl Event {
    pub fn write_failure(error: &io::Error) -> Self {
        match error.raw_os_error() {
            Some(nix::libc::EPIPE) => Self::WriteEpipe,
            Some(nix::libc::EAGAIN) => Self::WriteWouldBlock,
            Some(nix::libc::EBADF) => Self::WriteBadFd,
            Some(nix::libc::EINVAL) => Self::WriteInvalid,
            Some(nix::libc::EPERM) => Self::WritePermission,
            Some(nix::libc::EACCES) => Self::WriteAccess,
            Some(nix::libc::EMSGSIZE) => Self::WriteMessageSize,
            Some(nix::libc::ECONNRESET) => Self::WriteConnectionReset,
            Some(nix::libc::ENOBUFS) => Self::WriteNoBuffers,
            Some(nix::libc::ENOTSOCK) => Self::WriteNotSocket,
            Some(nix::libc::EINTR) => Self::WriteInterrupted,
            _ => Self::WriteOther,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Enter => "enter",
            Self::Failed => "failed",
            Self::Handoff => "handoff",
            Self::HandoffUncertain => "handoff-uncertain",
            Self::WriteError => "write-error",
            Self::WriteEpipe => "write-epipe",
            Self::WriteWouldBlock => "write-would-block",
            Self::WriteBadFd => "write-bad-fd",
            Self::WriteInvalid => "write-invalid",
            Self::WritePermission => "write-permission",
            Self::WriteAccess => "write-access",
            Self::WriteMessageSize => "write-message-size",
            Self::WriteConnectionReset => "write-connection-reset",
            Self::WriteNoBuffers => "write-no-buffers",
            Self::WriteNotSocket => "write-not-socket",
            Self::WriteInterrupted => "write-interrupted",
            Self::WriteOther => "write-other",
            Self::WriteZero => "write-zero",
            Self::WriteShort => "write-short",
            Self::CoreDiagnosticUnavailable => "core-diagnostic-unavailable",
            Self::CoreDiagnosticInvalid => "core-diagnostic-invalid",
            Self::End => "end",
        }
    }
}
// Fixed C diagnostic vocabulary, not request data or authority selectors.
fn core_stage(value: u8) -> Option<&'static str> {
    Some(match value {
        1 => "arguments",
        2 => "channel",
        3 => "socket-option",
        4 => "send-header-wait",
        5 => "send-header",
        6 => "send-body-wait",
        7 => "send-body",
        8 => "receive-wait",
        9 => "receive",
        10 => "ancillary",
        11 => "reply",
        12 => "stdin-pipe",
        13 => "stdout-pipe",
        14 => "exit-socket",
        15 => "descriptor-flags",
        16 => "exit-option",
        17 => "receipt",
        _ => return None,
    })
}
fn core_category(value: u8) -> Option<&'static str> {
    Some(match value {
        1 => "invalid",
        2 => "clock",
        3 => "deadline",
        4 => "poll-timeout",
        5 => "poll-hangup",
        6 => "poll-invalid",
        7 => "poll-error",
        8 => "poll-other-revents",
        9 => "eof",
        10 => "truncated",
        11 => "rights",
        12 => "cloexec",
        13 => "send-zero",
        14 => "epipe",
        15 => "would-block",
        16 => "bad-fd",
        17 => "invalid-argument",
        18 => "permission",
        19 => "access",
        20 => "message-size",
        21 => "connection-reset",
        22 => "no-buffers",
        23 => "not-socket",
        24 => "interrupted",
        25 => "other-errno",
        26 => "no-memory",
        27 => "io",
        28 => "in-progress",
        29 => "already",
        _ => return None,
    })
}
#[cfg(test)]
#[path = "native_helper_diagnostics_tests.rs"]
mod tests;
