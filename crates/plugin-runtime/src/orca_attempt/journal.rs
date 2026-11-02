use crate::{BrokerError, NativeWrite, WriteResource, native_command::denied};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub struct Journal {
    home: PathBuf,
    writer: NativeWrite,
}
impl Journal {
    pub fn new(home: &Path) -> Result<Self, BrokerError> {
        use std::os::unix::fs::PermissionsExt;
        let directory = home.join("orca");
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(denied()),
        }
        let metadata = fs::symlink_metadata(&directory).map_err(|_| denied())?;
        if !metadata.is_dir() || metadata.uid() != nix::unistd::Uid::current().as_raw() {
            return Err(denied());
        }
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|_| denied())?;
        let path = home
            .join("orca.json")
            .to_str()
            .ok_or_else(denied)?
            .to_owned();
        Ok(Self {
            home: home.into(),
            writer: NativeWrite::prepare(
                home,
                &[WriteResource {
                    path,
                    kind: "file".into(),
                    operations: vec!["write".into()],
                }],
            )?,
        })
    }
    pub async fn lock(&self) -> Result<JournalLock, BrokerError> {
        self.lock_named("coordinator").await
    }
    pub async fn lock_named(&self, name: &str) -> Result<JournalLock, BrokerError> {
        let dir = self.home.join("orca");
        let d = fs::symlink_metadata(&dir).map_err(|_| denied())?;
        if !d.is_dir() || d.mode() & 0o077 != 0 || d.uid() != nix::unistd::Uid::current().as_raw() {
            return Err(denied());
        }
        if !["coordinator", "orca-group"].contains(&name) {
            return Err(denied());
        }
        let path = dir.join(format!("{name}.lock"));
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(file) => return Ok(JournalLock { path, file }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let m = fs::symlink_metadata(&path).map_err(|_| denied())?;
                    if !m.is_file()
                        || m.nlink() != 1
                        || m.uid() != nix::unistd::Uid::current().as_raw()
                    {
                        return Err(denied());
                    }
                    if m.modified()
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|d| d > Duration::from_secs(120))
                    {
                        fs::remove_file(&path).map_err(|_| denied())?;
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(BrokerError::Timeout);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(_) => return Err(denied()),
            }
        }
    }
    pub fn read(&self) -> Result<Value, BrokerError> {
        let path = self.home.join("orca.json");
        let mut state = match fs::symlink_metadata(&path) {
            Ok(m) => {
                if !m.is_file() || m.nlink() != 1 || m.uid() != nix::unistd::Uid::current().as_raw()
                {
                    return Err(denied());
                }
                serde_json::from_slice(&fs::read(path).map_err(|_| denied())?)
                    .unwrap_or(Value::Null)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
            Err(_) => return Err(denied()),
        };
        if !state.is_object() {
            state = json!({"coordinator":null,"run":null});
        }
        for key in [
            "workers",
            "starting",
            "uncertain",
            "stranded",
            "unclosed",
            "strays",
            "removed",
            "groups",
        ] {
            if !state[key].is_object() {
                state[key] = json!({});
            }
        }
        Ok(state)
    }
    pub fn write(&mut self, state: &Value) -> Result<(), BrokerError> {
        let path = self.home.join("orca.json");
        self.writer.write_bytes(
            path.to_str().ok_or_else(denied)?,
            &serde_json::to_vec(state).map_err(|_| denied())?,
        )?;
        Ok(())
    }
    pub async fn mutate<T>(
        &mut self,
        change: impl FnOnce(&mut Value) -> Result<T, BrokerError>,
    ) -> Result<T, BrokerError> {
        let lock = self.lock().await?;
        let mut state = self.read()?;
        let result = change(&mut state)?;
        self.write(&state)?;
        lock.release()?;
        Ok(result)
    }
}
pub struct JournalLock {
    path: PathBuf,
    file: std::fs::File,
}
impl JournalLock {
    fn release(self) -> Result<(), BrokerError> {
        self.remove()
    }
    fn remove(&self) -> Result<(), BrokerError> {
        let m = match fs::symlink_metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(denied()),
        };
        let h = self.file.metadata().map_err(|_| denied())?;
        if m.dev() != h.dev() || m.ino() != h.ino() {
            return Err(denied());
        }
        fs::remove_file(&self.path).map_err(|_| denied())
    }
}
impl Drop for JournalLock {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}
