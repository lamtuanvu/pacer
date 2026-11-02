use super::{BrokerError, denied};
use nix::{
    errno::Errno,
    fcntl::{OFlag, open, openat},
    sys::stat::{Mode, mkdirat},
    unistd::Uid,
};
use std::{
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
fn flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
pub struct RunDirectory {
    pub path: PathBuf,
    pins: Vec<(PathBuf, File)>,
}
impl RunDirectory {
    pub fn claim(home: &Path, id: &str, attempt: u64, recover: bool) -> Result<Self, BrokerError> {
        let root = File::from(
            open(home, flags() | OFlag::O_DIRECTORY, Mode::empty()).map_err(|_| denied())?,
        );
        let mut pins = vec![(home.to_path_buf(), root)];
        for (index, name) in ["runs".to_owned(), id.into(), attempt.to_string()]
            .iter()
            .enumerate()
        {
            let (path, parent) = pins.last().ok_or_else(denied)?;
            match mkdirat(parent, name.as_str(), Mode::S_IRWXU) {
                Ok(()) => {}
                Err(Errno::EEXIST) if index < 2 || recover => {}
                Err(_) => return Err(denied()),
            }
            let child = File::from(
                openat(
                    parent,
                    name.as_str(),
                    flags() | OFlag::O_DIRECTORY,
                    Mode::empty(),
                )
                .map_err(|_| denied())?,
            );
            pins.push((path.join(name), child));
        }
        let path = pins.last().ok_or_else(denied)?.0.clone();
        let result = Self { path, pins };
        result.check()?;
        if fs::read_dir(&result.path)
            .map_err(|_| denied())?
            .next()
            .is_some()
        {
            return Err(denied());
        }
        result.check()?;
        Ok(result)
    }
    pub fn existing(home: &Path, id: &str, attempt: u64) -> Result<Self, BrokerError> {
        let mut pins = vec![];
        let mut path = home.to_path_buf();
        for name in [
            None,
            Some("runs".to_owned()),
            Some(id.into()),
            Some(attempt.to_string()),
        ] {
            if let Some(name) = name {
                path.push(name);
            }
            let file = if let Some((_, parent)) = pins.last() {
                File::from(
                    openat(
                        parent,
                        path.file_name().ok_or_else(denied)?,
                        flags() | OFlag::O_DIRECTORY,
                        Mode::empty(),
                    )
                    .map_err(|_| denied())?,
                )
            } else {
                File::from(
                    open(&path, flags() | OFlag::O_DIRECTORY, Mode::empty())
                        .map_err(|_| denied())?,
                )
            };
            pins.push((path.clone(), file));
        }
        let result = Self { path, pins };
        result.check()?;
        Ok(result)
    }
    pub fn check(&self) -> Result<(), BrokerError> {
        for (index, (path, fd)) in self.pins.iter().enumerate() {
            let opened = fd.metadata().map_err(|_| denied())?;
            let linked = fs::symlink_metadata(path).map_err(|_| denied())?;
            if !opened.is_dir()
                || !linked.is_dir()
                || !same(&opened, &linked)
                || opened.uid() != Uid::current().as_raw()
                || opened.mode() & if index == 0 { 0o022 } else { 0o077 } != 0
            {
                return Err(denied());
            }
        }
        let canonical = fs::canonicalize(&self.pins[0].0).map_err(|_| denied())?;
        let suffix = self
            .path
            .strip_prefix(&self.pins[0].0)
            .map_err(|_| denied())?;
        if fs::canonicalize(&self.path).map_err(|_| denied())? != canonical.join(suffix) {
            return Err(denied());
        }
        Ok(())
    }
    pub fn bytes(&self, name: &str, tail: usize) -> Result<Option<Vec<u8>>, BrokerError> {
        self.check()?;
        let parent = &self.pins.last().ok_or_else(denied)?.1;
        let mut file = match openat(parent, name, flags(), Mode::empty()) {
            Ok(fd) => File::from(fd),
            Err(Errno::ENOENT) => return Ok(None),
            Err(_) => return Err(denied()),
        };
        let m = file.metadata().map_err(|_| denied())?;
        if !m.is_file() || m.uid() != Uid::current().as_raw() {
            return Err(denied());
        }
        let count = m.len().min(tail as u64);
        file.seek(SeekFrom::Start(m.len() - count))
            .map_err(|_| denied())?;
        let mut bytes = vec![];
        file.take(count)
            .read_to_end(&mut bytes)
            .map_err(|_| denied())?;
        self.check()?;
        Ok(Some(bytes))
    }
    pub fn write(&self, name: &str, bytes: &[u8]) -> Result<(), BrokerError> {
        self.check()?;
        let path = self.path.join(name).to_string_lossy().into_owned();
        let mut writer = crate::NativeWrite::prepare(
            &self.path,
            &[crate::WriteResource {
                path: path.clone(),
                kind: "file".into(),
                operations: vec!["write".into()],
            }],
        )?;
        writer.write_bytes(&path, bytes)?;
        self.check()
    }
    pub fn publish(&self, name: &str, bytes: &[u8], mode: u32) -> Result<(), BrokerError> {
        use nix::fcntl::AtFlags;
        use nix::unistd::{UnlinkatFlags, linkat, unlinkat};
        use std::io::Write;
        self.check()?;
        let parent = &self.pins.last().ok_or_else(denied)?.1;
        let temp = format!(".pacer-{}.tmp", uuid::Uuid::new_v4());
        let mut file = File::from(
            openat(
                parent,
                temp.as_str(),
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(mode as libc::mode_t),
            )
            .map_err(|_| denied())?,
        );
        let result: Result<(), BrokerError> = (|| {
            file.write_all(bytes).map_err(|_| denied())?;
            file.sync_all().map_err(|_| denied())?;
            self.check()?;
            linkat(parent, temp.as_str(), parent, name, AtFlags::empty()).map_err(|_| denied())?;
            Ok(())
        })();
        let _ = unlinkat(parent, temp.as_str(), UnlinkatFlags::NoRemoveDir);
        result?;
        self.check()
    }
}
