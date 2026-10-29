//! Root-owned public native listener; the core receives a duplicate, never unlink rights.
use super::native_trust::ProcessIdentity;
use std::{
    io,
    io::Write,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
};

pub struct NativeListener {
    listener: UnixListener,
    path: PathBuf,
    owner: PathBuf,
    directory: std::fs::File,
    socket_inode: u64,
    owner_inode: u64,
}
impl NativeListener {
    pub fn bind(home: &Path, port: u16, process: &ProcessIdentity) -> io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let root = Path::new("/private/tmp").symlink_metadata()?;
        if !root.is_dir() || root.uid() != 0 || root.mode() & 0o1000 == 0 {
            return Err(denied());
        }
        let path = socket_path(home, port, nix::unistd::getuid().as_raw())?;
        let parent = path.parent().ok_or_else(denied)?;
        match std::fs::DirBuilder::new().mode(0o700).create(parent) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        Self::bind_at(path, process)
    }
    pub fn listener(&self) -> &UnixListener {
        &self.listener
    }
    fn bind_at(path: PathBuf, process: &ProcessIdentity) -> io::Result<Self> {
        let parent = path.parent().ok_or_else(denied)?;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY)
            .open(parent)?;
        let metadata = directory.metadata()?;
        if !metadata.is_dir()
            || metadata.uid() != nix::unistd::getuid().as_raw()
            || metadata.mode() & 0o077 != 0
            || !same_file(&metadata, &parent.symlink_metadata()?)
        {
            return Err(denied());
        }
        let owner = path.with_extension("sock.owner");
        remove_stale(&directory, &path, &owner)?;
        for candidate in [&path, &owner] {
            match candidate.symlink_metadata() {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                _ => return Err(denied()),
            }
        }
        let listener = bind_private(&path)?;
        let socket = path.symlink_metadata()?;
        use std::os::unix::fs::FileTypeExt;
        if !socket.file_type().is_socket()
            || socket.uid() != metadata.uid()
            || socket.mode() & 0o077 != 0
            || socket.ino() > 9_007_199_254_740_991
        {
            return Err(denied());
        }
        let socket_inode = socket.ino();
        let mut result = Self {
            listener,
            path,
            owner,
            directory,
            socket_inode,
            owner_inode: 0,
        };
        result.check_directory()?;
        result.listener.set_nonblocking(true)?;
        let record = serde_json::to_vec(&serde_json::json!({
            "process": {"pid": process.pid, "bootId": process.boot_id, "birth": process.birth},
            "inode": socket_inode,
        }))?;
        // A hard link publishes a complete record without replacing any prior entry.
        let temporary = result
            .path
            .with_extension(format!("owner-{}", hex::encode(rand::random::<[u8; 16]>())));
        use nix::{
            fcntl::{AtFlags, OFlag, openat},
            sys::stat::Mode,
            unistd::{UnlinkatFlags, linkat, unlinkat},
        };
        let temporary_name = temporary.file_name().ok_or_else(denied)?;
        let owner_name = result.owner.file_name().ok_or_else(denied)?.to_owned();
        let mut file = std::fs::File::from(openat(
            &result.directory,
            temporary_name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )?);
        let temporary_inode = file.metadata()?.ino();
        let publish = (|| {
            file.write_all(&record)?;
            file.sync_all()?;
            result.check_directory()?;
            linkat(
                &result.directory,
                temporary_name,
                &result.directory,
                owner_name.as_os_str(),
                AtFlags::empty(),
            )?;
            result.owner_inode = temporary_inode;
            Ok::<_, io::Error>(())
        })();
        if entry_inode(&result.directory, temporary_name) == Some(temporary_inode) {
            let _ = unlinkat(
                &result.directory,
                temporary_name,
                UnlinkatFlags::NoRemoveDir,
            );
        }
        publish?;
        result.directory.sync_all()?;
        result.check_directory()?;
        Ok(result)
    }
    fn check_directory(&self) -> io::Result<()> {
        let metadata = self.directory.metadata()?;
        let path = self.path.parent().ok_or_else(denied)?.symlink_metadata()?;
        if !same_file(&metadata, &path) || !path.is_dir() || path.mode() & 0o077 != 0 {
            return Err(denied());
        }
        Ok(())
    }
}
fn denied() -> io::Error {
    io::Error::other("native listener ownership unavailable")
}
fn bind_private(path: &Path) -> io::Result<UnixListener> {
    use nix::sys::stat::{Mode, umask};
    static BIND: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = BIND.lock().map_err(|_| denied())?;
    struct Restore(Mode);
    impl Drop for Restore {
        fn drop(&mut self) {
            umask(self.0);
        }
    }
    // Restrict at creation; never chmod a pathname that could have been redirected.
    // No await or child spawn occurs while the process mask is restricted.
    let _mask = Restore(umask(Mode::from_bits_truncate(0o177)));
    UnixListener::bind(path)
}
fn remove_stale(directory: &std::fs::File, path: &Path, owner: &Path) -> io::Result<()> {
    use nix::{
        fcntl::{AtFlags, OFlag, openat},
        sys::{
            socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket},
            stat::{Mode, fstatat},
        },
        unistd::{UnlinkatFlags, unlinkat},
    };
    use std::{io::Read, os::fd::AsRawFd};
    let name = path.file_name().ok_or_else(denied)?;
    let owner_name = owner.file_name().ok_or_else(denied)?;
    let old = match fstatat(directory, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(value) => value,
        Err(nix::errno::Errno::ENOENT) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if old.st_mode & nix::libc::S_IFMT != nix::libc::S_IFSOCK
        || old.st_uid != nix::unistd::getuid().as_raw()
        || old.st_mode & 0o077 != 0
    {
        return Err(denied());
    }
    let file = std::fs::File::from(openat(
        directory,
        owner_name,
        OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )?);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != old.st_uid
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 4096
    {
        return Err(denied());
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(denied());
    }
    let record: serde_json::Value = serde_json::from_slice(&bytes)?;
    let pid = record["process"]["pid"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 1)
        .ok_or_else(denied)?;
    let boot = record["process"]["bootId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(denied)?;
    let birth = record["process"]["birth"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(denied)?;
    if record["inode"].as_u64() != Some(old.st_ino) {
        return Err(denied());
    }
    match super::native_trust::process_details(pid) {
        Ok(current) if current.process.boot_id != boot || current.process.birth != birth => {}
        Ok(_) => return Err(denied()),
        Err(_) => {
            let pid = i32::try_from(pid).map_err(|_| denied())?;
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None)
                != Err(nix::errno::Errno::ESRCH)
            {
                return Err(denied());
            }
        }
    }
    // A forged stale record cannot authorize removing a live kernel listener.
    let probe = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::empty(),
        None,
    )?;
    nix::fcntl::fcntl(
        &probe,
        nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::FD_CLOEXEC),
    )?;
    nix::fcntl::fcntl(&probe, nix::fcntl::FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;
    if connect(probe.as_raw_fd(), &UnixAddr::new(path)?) != Err(nix::errno::Errno::ECONNREFUSED)
        || entry_inode(directory, name) != Some(old.st_ino)
        || entry_inode(directory, owner_name) != Some(metadata.ino())
    {
        return Err(denied());
    }
    unlinkat(directory, name, UnlinkatFlags::NoRemoveDir)?;
    unlinkat(directory, owner_name, UnlinkatFlags::NoRemoveDir)?;
    Ok(())
}
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}
fn entry_inode(directory: &std::fs::File, name: &std::ffi::OsStr) -> Option<u64> {
    nix::sys::stat::fstatat(directory, name, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW)
        .ok()
        .filter(|m| m.st_uid == nix::unistd::getuid().as_raw())
        .map(|m| m.st_ino)
}
impl Drop for NativeListener {
    fn drop(&mut self) {
        if self.check_directory().is_err() {
            return;
        }
        for (path, inode) in [
            (&self.path, self.socket_inode),
            (&self.owner, self.owner_inode),
        ] {
            if let Some(name) = path.file_name()
                && inode != 0
                && entry_inode(&self.directory, name) == Some(inode)
            {
                let _ = nix::unistd::unlinkat(
                    &self.directory,
                    name,
                    nix::unistd::UnlinkatFlags::NoRemoveDir,
                );
            }
        }
    }
}
fn socket_path(home: &Path, port: u16, uid: u32) -> io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    if port == 0 {
        return Err(denied());
    }
    let home = home.canonicalize()?;
    let home = home
        .to_str()
        .ok_or_else(|| io::Error::other("invalid native home"))?;
    let hash = hex::encode(Sha256::digest(format!("{home}\n{port}\n{uid}")));
    Ok(PathBuf::from(format!(
        "/private/tmp/pacer-native-{uid}/{}.sock",
        &hash[..32]
    )))
}

#[cfg(test)]
#[path = "native_listener_tests.rs"]
mod tests;
