//! Host-owned binary stream stages. Files stay private and never enter capability results.
use crate::native_process::{Image, OwnedChild, terminate};
use crate::{AuthorityError, BrokerError};
use nix::{
    errno::Errno,
    fcntl::{OFlag, open, openat},
    sys::stat::{Mode, mkdirat},
    unistd::{Uid, UnlinkatFlags, unlinkat},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, Metadata, Permissions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};
pub struct BundleSpec {
    pub argv: Vec<String>,
    pub executable: String,
    pub env: HashMap<String, String>,
    pub timeout_ms: u64,
    pub max_bytes: u64,
}
fn denied() -> BrokerError {
    AuthorityError::Denied("bundle stage identity or owning request changed".into()).into()
}
fn flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.mode() == b.mode()
}
struct Stage {
    root: File,
    directory: File,
    name: String,
    file: File,
    identity: Metadata,
    bytes: u64,
    sha256: String,
}
impl Stage {
    fn check(&self) -> Result<(), BrokerError> {
        let named = File::from(
            openat(&self.root, self.name.as_str(), flags(), Mode::empty()).map_err(|_| denied())?,
        );
        let a = named.metadata().map_err(|_| denied())?;
        let b = self.directory.metadata().map_err(|_| denied())?;
        let file = File::from(
            openat(
                &self.directory,
                "out.bundle",
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| denied())?,
        );
        if a.dev() != b.dev()
            || a.ino() != b.ino()
            || !same(&file.metadata().map_err(|_| denied())?, &self.identity)
            || !same(&self.file.metadata().map_err(|_| denied())?, &self.identity)
        {
            return Err(denied());
        }
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let owned = openat(
            &self.directory,
            "out.bundle",
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .ok()
        .and_then(|f| f.metadata().ok())
        .is_some_and(|m| {
            m.is_file() && m.dev() == self.identity.dev() && m.ino() == self.identity.ino()
        });
        if owned {
            let _ = unlinkat(&self.directory, "out.bundle", UnlinkatFlags::NoRemoveDir);
            let _ = unlinkat(&self.root, self.name.as_str(), UnlinkatFlags::RemoveDir);
        }
    }
}
pub struct BundleTicket {
    stage: Stage,
}
impl BundleTicket {
    pub fn bytes(&self) -> u64 {
        self.stage.bytes
    }
    pub fn sha256(&self) -> &str {
        &self.stage.sha256
    }
    pub fn read(&mut self) -> Result<Vec<u8>, BrokerError> {
        self.stage.check()?;
        self.stage
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|_| denied())?;
        let mut bytes = vec![];
        Read::by_ref(&mut self.stage.file)
            .take(self.stage.bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| denied())?;
        self.stage.check()?;
        if bytes.len() as u64 != self.stage.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != self.stage.sha256
        {
            return Err(denied());
        }
        Ok(bytes)
    }
}
pub struct NativeBundle {
    spec: BundleSpec,
    image: Image,
    home: std::path::PathBuf,
    home_image: Metadata,
    root: File,
    root_image: Metadata,
    used: bool,
    stages: HashMap<String, Stage>,
}
impl NativeBundle {
    pub fn prepare(home: &Path, spec: BundleSpec) -> Result<Self, BrokerError> {
        if spec.argv.first().map(String::as_str) != Some("ssh")
            || spec.timeout_ms == 0
            || spec.timeout_ms > 60_000
            || spec.max_bytes == 0
            || spec.max_bytes > 50 * 1024 * 1024
        {
            return Err(denied());
        }
        let directory = File::from(open(home, flags(), Mode::empty()).map_err(|_| denied())?);
        let home_image = directory.metadata().map_err(|_| denied())?;
        if home_image.uid() != Uid::current().as_raw() || home_image.mode() & 0o022 != 0 {
            return Err(denied());
        }
        match mkdirat(&directory, "transfers", Mode::S_IRWXU) {
            Ok(()) | Err(Errno::EEXIST) => {}
            Err(_) => return Err(denied()),
        }
        let root = File::from(
            openat(&directory, "transfers", flags(), Mode::empty()).map_err(|_| denied())?,
        );
        let root_image = root.metadata().map_err(|_| denied())?;
        if root_image.uid() != Uid::current().as_raw() || root_image.mode() & 0o077 != 0 {
            return Err(denied());
        }
        let image = Image::pin(&spec.executable, true)?;
        Ok(Self {
            spec,
            image,
            home: home.into(),
            home_image,
            root,
            root_image,
            used: false,
            stages: HashMap::new(),
        })
    }
    fn check_root(&self) -> Result<(), BrokerError> {
        self.image.check()?;
        let home = std::fs::symlink_metadata(&self.home).map_err(|_| denied())?;
        let root = std::fs::symlink_metadata(self.home.join("transfers")).map_err(|_| denied())?;
        if !home.is_dir()
            || home.dev() != self.home_image.dev()
            || home.ino() != self.home_image.ino()
            || !root.is_dir()
            || root.dev() != self.root_image.dev()
            || root.ino() != self.root_image.ino()
            || root.uid() != self.root_image.uid()
            || root.mode() != self.root_image.mode()
        {
            return Err(denied());
        }
        Ok(())
    }
    pub fn claim(&mut self, handle: &str) -> Result<BundleTicket, BrokerError> {
        self.check_root()?;
        let stage = self.stages.remove(handle).ok_or_else(denied)?;
        stage.check()?;
        Ok(BundleTicket { stage })
    }
    pub async fn stage(&mut self, params: &Value, deadline: Instant) -> Result<Value, BrokerError> {
        let ms = params
            .get("timeoutMs")
            .and_then(crate::js_semantics::safe_u64)
            .filter(|n| *n > 0 && *n <= self.spec.timeout_ms)
            .ok_or_else(denied)?;
        let max = params
            .get("maxBytes")
            .and_then(crate::js_semantics::safe_u64)
            .filter(|n| *n > 0 && *n <= self.spec.max_bytes)
            .ok_or_else(denied)?;
        if self.used || params["argv"] != json!(self.spec.argv) || Instant::now() >= deadline {
            return Err(denied());
        }
        self.check_root()?;
        self.used = true;
        let name = format!("stage-{}", uuid::Uuid::new_v4());
        mkdirat(&self.root, name.as_str(), Mode::S_IRWXU).map_err(|_| denied())?;
        let directory = File::from(
            openat(&self.root, name.as_str(), flags(), Mode::empty()).map_err(|_| denied())?,
        );
        let file = File::from(
            openat(
                &directory,
                "out.bundle",
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::S_IRUSR | Mode::S_IWUSR,
            )
            .map_err(|_| denied())?,
        );
        file.set_permissions(Permissions::from_mode(0o600))
            .map_err(|_| denied())?;
        let identity = file.metadata().map_err(|_| denied())?;
        let mut stage = Stage {
            root: self.root.try_clone().map_err(|_| denied())?,
            directory,
            name,
            file,
            identity,
            bytes: 0,
            sha256: String::new(),
        };
        let mut child = OwnedChild(
            Command::new(&self.image.canonical)
                .args(&self.spec.argv[1..])
                .env_clear()
                .envs(&self.spec.env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| denied())?,
        );
        let mut output = child.stdout.take().ok_or_else(denied)?;
        let mut error = child.stderr.take().ok_or_else(denied)?;
        let (mut buffer, mut err_buffer) = (vec![0; 65_536], vec![0; 65_536]);
        let (mut out_end, mut err_end) = (false, false);
        let mut status = None;
        let mut error_bytes = 0;
        let mut hash = Sha256::new();
        let end = deadline.min(Instant::now() + Duration::from_millis(ms));
        let result: Result<(), BrokerError> = loop {
            if out_end && err_end && status.is_some() {
                break Ok(());
            }
            tokio::select! {
                read=output.read(&mut buffer),if !out_end=>{match read{Ok(0)=>out_end=true,Ok(n)=>{if stage.bytes+n as u64>max{break Err(BrokerError::Invalid("bundle exceeds issued byte limit"));}stage.file.write_all(&buffer[..n]).map_err(|_|denied())?;hash.update(&buffer[..n]);stage.bytes+=n as u64;},Err(_)=>break Err(denied())}},
                read=error.read(&mut err_buffer),if !err_end=>{match read{Ok(0)=>err_end=true,Ok(n)=>{error_bytes+=n;if error_bytes>65_536{break Err(BrokerError::Invalid("bundle stderr exceeds limit"));}},Err(_)=>break Err(denied())}},
                wait=child.wait(),if status.is_none()=>{match wait{Ok(code)=>status=Some(code),Err(_)=>break Err(denied())}},
                _=tokio::time::sleep_until(end.into())=>break Err(BrokerError::Timeout),
            }
        };
        if let Err(error) = result {
            terminate(&mut child).await?;
            stage.identity = stage.file.metadata().map_err(|_| denied())?;
            return Err(error);
        }
        if !status.is_some_and(|s| s.success()) {
            stage.identity = stage.file.metadata().map_err(|_| denied())?;
            return Err(denied());
        }
        stage.file.sync_all().map_err(|_| denied())?;
        stage.identity = stage.file.metadata().map_err(|_| denied())?;
        stage.sha256 = format!("{:x}", hash.finalize());
        self.check_root()?;
        stage.check()?;
        let handle = uuid::Uuid::new_v4().to_string();
        let result = json!({"handle":handle,"bytes":stage.bytes,"sha256":stage.sha256});
        self.stages.insert(handle, stage);
        Ok(result)
    }
}
