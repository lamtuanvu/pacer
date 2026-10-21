//! Owned native transaction assets. Paths originate in verified platform context.
use super::{journal::random_id, OtaError, TransactionLocks};
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString, OsStr, OsString},
    fs::{File, Metadata},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::MetadataExt,
        },
    },
    path::{Component, Path, PathBuf},
};
const MAX_TREE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: u64 = 100_000;
const MAX_DEPTH: u32 = 64;
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn require(value: bool) -> Result<(), OtaError> {
    if value {
        Ok(())
    } else {
        Err(OtaError::Identity)
    }
}
fn cstr(value: &OsStr) -> Result<CString, OtaError> {
    CString::new(value.as_bytes()).map_err(|_| OtaError::Invalid)
}
fn name(value: &str) -> Result<CString, OtaError> {
    require(!value.is_empty() && value != "." && value != ".." && !value.contains('/'))?;
    cstr(OsStr::new(value))
}
fn at(dir: &File, entry: &OsStr, flags: i32, mode: u32) -> Result<File, OtaError> {
    let entry = cstr(entry)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            entry.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        Err(OtaError::Io)
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn open_dir(path: &Path) -> Result<File, OtaError> {
    require(path.is_absolute())?;
    let mut file = File::open("/").map_err(|_| OtaError::Io)?;
    for part in path.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(part) => {
                file = at(&file, part, libc::O_RDONLY | libc::O_DIRECTORY, 0)?
            }
            _ => return Err(OtaError::Invalid),
        }
    }
    Ok(file)
}
fn metadata(file: &File) -> Result<Metadata, OtaError> {
    file.metadata().map_err(|_| OtaError::Io)
}
fn owned(meta: &Metadata) -> Result<(), OtaError> {
    require(meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o7022 == 0)
}
fn private(file: &File, directory: bool) -> Result<(), OtaError> {
    let meta = metadata(file)?;
    owned(&meta)?;
    require(
        meta.mode() & 0o7777 == if directory { 0o700 } else { 0o600 }
            && if directory {
                meta.is_dir()
            } else {
                meta.is_file() && meta.nlink() == 1
            },
    )
}
fn same(a: &Metadata, b: &Metadata) -> Result<(), OtaError> {
    require(a.dev() == b.dev() && a.ino() == b.ino())
}
fn unchanged(a: &Metadata, b: &Metadata) -> Result<(), OtaError> {
    same(a, b)?;
    require(
        a.size() == b.size()
            && a.mode() == b.mode()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec(),
    )
}
fn sync(file: &File) -> Result<(), OtaError> {
    file.sync_all().map_err(|_| OtaError::Io)
}
fn read_bounded(file: &File, limit: u64) -> Result<Vec<u8>, OtaError> {
    let before = metadata(file)?;
    require(before.is_file() && before.nlink() == 1 && before.len() <= limit)?;
    let mut bytes = Vec::new();
    file.take(limit.checked_add(1).ok_or(OtaError::Invalid)?)
        .read_to_end(&mut bytes)
        .map_err(|_| OtaError::Io)?;
    require(bytes.len() as u64 <= limit)?;
    unchanged(&before, &metadata(file)?)?;
    Ok(bytes)
}
pub(crate) fn read_owned_file(path: &Path, limit: u64) -> Result<Vec<u8>, OtaError> {
    let parent_path = path.parent().ok_or(OtaError::Invalid)?;
    let parent = open_dir(parent_path)?;
    let entry = path.file_name().ok_or(OtaError::Invalid)?;
    let file = at(&parent, entry, libc::O_RDONLY, 0)?;
    owned(&metadata(&file)?)?;
    let bytes = read_bounded(&file, limit)?;
    same(&metadata(&parent)?, &metadata(&open_dir(parent_path)?)?)?;
    let reopened = at(&parent, entry, libc::O_RDONLY, 0)?;
    same(&metadata(&file)?, &metadata(&reopened)?)?;
    Ok(bytes)
}
fn chmod(file: &File, mode: u32) -> Result<(), OtaError> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } != 0 {
        Err(OtaError::Io)
    } else {
        Ok(())
    }
}
fn mkdir(dir: &File, entry: &str) -> Result<File, OtaError> {
    let entry_c = name(entry)?;
    if unsafe { libc::mkdirat(dir.as_raw_fd(), entry_c.as_ptr(), 0o700) } != 0 {
        return Err(OtaError::Io);
    }
    let file = at(
        dir,
        OsStr::new(entry),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?;
    sync(dir)?;
    Ok(file)
}
fn rename_exclusive(from: &File, source: &str, to: &File, target: &str) -> Result<(), OtaError> {
    let source = name(source)?;
    let target = name(target)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            from.as_raw_fd(),
            source.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            from.as_raw_fd(),
            source.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let result = -1;
    if result != 0 {
        return Err(OtaError::Io);
    }
    sync(from)?;
    sync(to)
}

pub(crate) struct PrivateDir {
    pub(crate) path: PathBuf,
    directory: File,
}
pub(crate) struct NativeLocks {
    _files: Vec<File>,
}
impl TransactionLocks for NativeLocks {}
impl Drop for NativeLocks {
    fn drop(&mut self) {
        // A fork may inherit the same open file description. The owning scope
        // releases its lock explicitly; it must not depend on child exec/reap.
        for file in &self._files {
            unsafe {
                libc::flock(file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}
impl PrivateDir {
    pub(crate) fn require_same_volume(&self, directory: &Path) -> Result<(), OtaError> {
        self.current()?;
        require(metadata(&self.directory)?.dev() == metadata(&open_dir(directory)?)?.dev())
    }
    pub(crate) fn prune_bundle(&self, entry: &str, expected: &str) -> Result<(), OtaError> {
        self.current()?;
        name(entry)?;
        require(valid_hash(expected))?;
        let source = at(
            &self.directory,
            OsStr::new(entry),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        let before = metadata(&source)?;
        require(hash_tree(&source)?.0 == expected)?;
        let retained = format!(".prune-bundle-{}", random_id()?);
        rename_exclusive(&self.directory, entry, &self.directory, &retained)?;
        let moved = at(
            &self.directory,
            OsStr::new(&retained),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        same(&before, &metadata(&moved)?)?;
        require(hash_tree(&moved)?.0 == expected)?;
        // A crash leaves the isolated partial tree for explicit inspection. Never
        // reinterpret an unknown retained tree as a verified backup to remove.
        remove_verified_tree(&moved)?;
        same(&metadata(&source)?, &metadata(&moved)?)?;
        let entry = name(&retained)?;
        if unsafe {
            libc::unlinkat(
                self.directory.as_raw_fd(),
                entry.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(OtaError::Io);
        }
        sync(&self.directory)?;
        self.current()
    }
    pub(crate) fn prune_file(&self, entry: &str, expected: &str) -> Result<(), OtaError> {
        self.current()?;
        name(entry)?;
        require(valid_hash(expected))?;
        let file = at(&self.directory, OsStr::new(entry), libc::O_RDONLY, 0)?;
        let before = metadata(&file)?;
        owned(&before)?;
        require(before.is_file() && before.nlink() == 1 && before.mode() & 0o077 == 0)?;
        require(
            format!(
                "{:x}",
                Sha256::digest(read_bounded(&file, super::updater::MAX_ARTIFACT_BYTES)?)
            ) == expected,
        )?;
        let retained = format!(".prune-file-{}", random_id()?);
        rename_exclusive(&self.directory, entry, &self.directory, &retained)?;
        let moved = at(&self.directory, OsStr::new(&retained), libc::O_RDONLY, 0)?;
        same(&before, &metadata(&moved)?)?;
        // Our rename changes ctime. Preserve the content/type invariants and
        // rehash the held inode instead of treating that expected ctime change
        // as an external mutation.
        let after = metadata(&file)?;
        require(
            before.len() == after.len()
                && before.mode() == after.mode()
                && before.mtime() == after.mtime()
                && before.mtime_nsec() == after.mtime_nsec(),
        )?;
        require(
            format!(
                "{:x}",
                Sha256::digest(read_bounded(&moved, super::updater::MAX_ARTIFACT_BYTES)?)
            ) == expected,
        )?;
        let entry = name(&retained)?;
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
            return Err(OtaError::Io);
        }
        sync(&self.directory)?;
        self.current()
    }
    pub(crate) fn lock_named(&self, entry: &str) -> Result<NativeLocks, OtaError> {
        self.current()?;
        name(entry)?;
        let file = at(
            &self.directory,
            OsStr::new(entry),
            libc::O_RDWR | libc::O_CREAT,
            0o600,
        )?;
        private(&file, false)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
                    OtaError::Busy
                } else {
                    OtaError::Io
                },
            );
        }
        let reopened = at(&self.directory, OsStr::new(entry), libc::O_RDONLY, 0)?;
        same(&metadata(&file)?, &metadata(&reopened)?)?;
        self.current()?;
        Ok(NativeLocks { _files: vec![file] })
    }
    /// Caller holds the stable writer lock; stale snapshots cannot overwrite a
    /// cooperating writer. Every read/publication uses the held directory inode.
    pub(crate) fn replace_exact(
        &self,
        entry: &str,
        expected: &[u8],
        next: &[u8],
    ) -> Result<(), OtaError> {
        self.current()?;
        name(entry)?;
        let old = at(&self.directory, OsStr::new(entry), libc::O_RDONLY, 0)?;
        private(&old, false)?;
        require(read_bounded(&old, expected.len() as u64 + 1)? == expected)?;
        let old_meta = metadata(&old)?;
        let temporary = format!(".asset-{}", random_id()?);
        let mut file = at(
            &self.directory,
            OsStr::new(&temporary),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        private(&file, false)?;
        file.write_all(next).map_err(|_| OtaError::Io)?;
        sync(&file)?;
        self.current()?;
        let reopened = at(&self.directory, OsStr::new(entry), libc::O_RDONLY, 0)?;
        same(&old_meta, &metadata(&reopened)?)?;
        unchanged(&old_meta, &metadata(&old)?)?;
        require(read_bounded(&reopened, expected.len() as u64 + 1)? == expected)?;
        let source = name(&temporary)?;
        let destination = name(entry)?;
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                source.as_ptr(),
                self.directory.as_raw_fd(),
                destination.as_ptr(),
            )
        } != 0
        {
            return Err(OtaError::Io);
        }
        sync(&self.directory)?;
        self.current()?;
        require(self.read(entry, next.len() as u64 + 1)? == next)
    }
    pub(crate) fn stage_helper(&self, source: &Path, expected: &str) -> Result<(), OtaError> {
        require(valid_hash(expected))?;
        let bytes = read_owned_file(source, 128 * 1024 * 1024)?;
        require(format!("{:x}", Sha256::digest(&bytes)) == expected)?;
        self.current()?;
        let entry = "pacer-update-helper";
        if stat_at(&self.directory, OsStr::new(entry)).is_err() {
            require(std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound)?;
            self.write_new(entry, &bytes)?;
        }
        let file = at(&self.directory, OsStr::new(entry), libc::O_RDONLY, 0)?;
        let before = metadata(&file)?;
        owned(&before)?;
        require(
            before.is_file()
                && before.nlink() == 1
                && matches!(before.mode() & 0o7777, 0o600 | 0o700),
        )?;
        require(read_bounded(&file, 128 * 1024 * 1024)? == bytes)?;
        unchanged(&before, &metadata(&file)?)?;
        chmod(&file, 0o700)?;
        sync(&file)?;
        sync(&self.directory)?;
        self.current()
    }
    pub(crate) fn installation(home: &Path, installation_id: &str) -> Result<Self, OtaError> {
        require(
            !installation_id.is_empty()
                && installation_id.len() <= 128
                && installation_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        )?;
        require(home.canonicalize().map_err(|_| OtaError::Identity)? == home)?;
        let parent = open_dir(home)?;
        owned(&metadata(&parent)?)?;
        let updates = Self::create_at(&parent, &home.join("desktop-updates"))?;
        same(&metadata(&parent)?, &metadata(&open_dir(home)?)?)?;
        updates.child("native")?.child(installation_id)
    }
    pub(crate) fn downloads(home: &Path, installation_id: &str) -> Result<Self, OtaError> {
        Self::installation(home, installation_id)?.child("downloads")
    }
    pub(crate) fn store_archive(&self, sha256: &str, bytes: &[u8]) -> Result<(), OtaError> {
        require(
            bytes.len() as u64 <= super::updater::MAX_ARTIFACT_BYTES
                && valid_hash(sha256)
                && format!("{:x}", Sha256::digest(bytes)) == sha256,
        )?;
        if self.read_archive(sha256).is_ok() {
            return Ok(());
        }
        match self.write_new(&format!("{sha256}.tar.gz"), bytes) {
            Ok(()) => Ok(()),
            // Another cooperating helper may already have published the same
            // immutable package. Reopen safely; never overwrite its bytes.
            Err(error) => self.read_archive(sha256).map(|_| ()).map_err(|_| error),
        }
    }
    pub(crate) fn read_archive(&self, sha256: &str) -> Result<Vec<u8>, OtaError> {
        require(valid_hash(sha256))?;
        let bytes = self.read(
            &format!("{sha256}.tar.gz"),
            super::updater::MAX_ARTIFACT_BYTES,
        )?;
        require(format!("{:x}", Sha256::digest(&bytes)) == sha256)?;
        Ok(bytes)
    }
    pub(crate) fn open(path: &Path) -> Result<Self, OtaError> {
        let directory = open_dir(path)?;
        private(&directory, true)?;
        Ok(Self {
            path: path.into(),
            directory,
        })
    }
    pub(crate) fn create(path: &Path) -> Result<Self, OtaError> {
        let parent = open_dir(path.parent().ok_or(OtaError::Invalid)?)?;
        Self::create_at(&parent, path)
    }
    fn create_at(parent: &File, path: &Path) -> Result<Self, OtaError> {
        let entry = path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or(OtaError::Invalid)?;
        let entry_c = name(entry)?;
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), entry_c.as_ptr(), 0o700) };
        if result != 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(OtaError::Io);
        }
        sync(parent)?;
        let directory = at(
            parent,
            OsStr::new(entry),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        private(&directory, true)?;
        let result = Self {
            path: path.into(),
            directory,
        };
        result.current()?;
        Ok(result)
    }
    fn current(&self) -> Result<(), OtaError> {
        private(&self.directory, true)?;
        let reopened = open_dir(&self.path)?;
        private(&reopened, true)?;
        same(&metadata(&self.directory)?, &metadata(&reopened)?)
    }
    pub(crate) fn child(&self, entry: &str) -> Result<Self, OtaError> {
        self.current()?;
        name(entry)?;
        let result = Self::create_at(&self.directory, &self.path.join(entry))?;
        self.current()?;
        Ok(result)
    }
    pub(crate) fn read(&self, entry: &str, limit: u64) -> Result<Vec<u8>, OtaError> {
        self.current()?;
        name(entry)?;
        let file = at(&self.directory, OsStr::new(entry), libc::O_RDONLY, 0)?;
        private(&file, false)?;
        let before = metadata(&file)?;
        require(before.len() <= limit)?;
        let mut bytes = Vec::new();
        (&file)
            .take(limit.checked_add(1).ok_or(OtaError::Invalid)?)
            .read_to_end(&mut bytes)
            .map_err(|_| OtaError::Io)?;
        require(bytes.len() as u64 <= limit)?;
        unchanged(&before, &metadata(&file)?)?;
        self.current()?;
        Ok(bytes)
    }
    pub(crate) fn write_new(&self, entry: &str, bytes: &[u8]) -> Result<(), OtaError> {
        self.current()?;
        name(entry)?;
        if stat_at(&self.directory, OsStr::new(entry)).is_ok()
            || std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
        {
            return Err(OtaError::Identity);
        }
        let temporary = format!(".asset-{}", random_id()?);
        let mut file = at(
            &self.directory,
            OsStr::new(&temporary),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        private(&file, false)?;
        file.write_all(bytes).map_err(|_| OtaError::Io)?;
        sync(&file)?;
        self.current()?;
        rename_exclusive(&self.directory, &temporary, &self.directory, entry)?;
        self.current()
    }
    pub(crate) fn copy_bundle(
        &self,
        source: &Path,
        entry: &str,
        expected: &str,
    ) -> Result<(), OtaError> {
        self.current()?;
        name(entry)?;
        let source = open_dir(source)?;
        let temporary = format!(".bundle-{}", random_id()?);
        copy_verified(&source, &self.directory, &temporary, expected)?;
        self.current()?;
        rename_exclusive(&self.directory, &temporary, &self.directory, entry)?;
        self.current()
    }
    pub(crate) fn acquire_locks(&self, app: &Path, home: &Path) -> Result<NativeLocks, OtaError> {
        self.current()?;
        require(app.is_absolute() && home.is_absolute())?;
        let canonical_home = home.canonicalize().map_err(|_| OtaError::Identity)?;
        require(canonical_home == home)?;
        // The app can be absent during recovery. Canonical parent + fixed basename
        // keeps the same lock identity while replacement is incomplete.
        let parent = app.parent().ok_or(OtaError::Invalid)?;
        require(parent.canonicalize().map_err(|_| OtaError::Identity)? == parent)?;
        let app_name = app.file_name().ok_or(OtaError::Invalid)?;
        name(app_name.to_str().ok_or(OtaError::Invalid)?)?;
        let mut keys = [
            format!("app-{:x}", Sha256::digest(app.as_os_str().as_bytes())),
            format!("home-{:x}", Sha256::digest(home.as_os_str().as_bytes())),
        ];
        keys.sort();
        let mut files = Vec::new();
        for key in keys {
            let file = at(
                &self.directory,
                OsStr::new(&key),
                libc::O_RDWR | libc::O_CREAT,
                0o600,
            )?;
            private(&file, false)?;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
                        OtaError::Busy
                    } else {
                        OtaError::Io
                    },
                );
            }
            files.push(file)
        }
        self.current()?;
        sync(&self.directory)?;
        Ok(NativeLocks { _files: files })
    }
}

struct DirStream(*mut libc::DIR);
impl Drop for DirStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}
fn entries(dir: &File) -> Result<Vec<OsString>, OtaError> {
    let duplicate = at(dir, OsStr::new("."), libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    use std::os::fd::IntoRawFd;
    let fd = duplicate.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(OtaError::Io);
    }
    let stream = DirStream(stream);
    let mut names = Vec::new();
    loop {
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0 {
                return Err(OtaError::Io);
            }
            break;
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes != b"." && bytes != b".." {
            require(names.len() < MAX_ENTRIES as usize)?;
            names.push(OsString::from_vec(bytes.to_vec()))
        }
    }
    names.sort();
    Ok(names)
}
fn stat_at(dir: &File, entry: &OsStr) -> Result<libc::stat, OtaError> {
    let entry = cstr(entry)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            entry.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(OtaError::Io);
    }
    Ok(unsafe { stat.assume_init() })
}
fn record(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes)
}
#[derive(Default)]
struct Budget {
    bytes: u64,
    entries: u64,
}
fn tree(
    source: &File,
    destination: Option<&File>,
    hash: &mut Sha256,
    budget: &mut Budget,
    depth: u32,
) -> Result<(), OtaError> {
    require(depth <= MAX_DEPTH)?;
    let before = metadata(source)?;
    owned(&before)?;
    require(before.is_dir())?;
    hash.update((before.mode() & 0o7777).to_be_bytes());
    for entry in entries(source)? {
        budget.entries += 1;
        require(budget.entries <= MAX_ENTRIES)?;
        let raw = stat_at(source, &entry)?;
        require(raw.st_uid == unsafe { libc::geteuid() })?;
        if raw.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFLNK as u32 {
            require(raw.st_mode as u32 & 0o7022 == 0)?;
        }
        record(hash, entry.as_bytes());
        match raw.st_mode as u32 & libc::S_IFMT as u32 {
            kind if kind == libc::S_IFDIR as u32 => {
                hash.update(b"d");
                let input = at(source, &entry, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
                let meta = metadata(&input)?;
                require(meta.ino() == raw.st_ino as u64 && meta.dev() == raw.st_dev as u64)?;
                let output = if let Some(output) = destination {
                    Some(mkdir(output, entry.to_str().ok_or(OtaError::Invalid)?)?)
                } else {
                    None
                };
                tree(&input, output.as_ref(), hash, budget, depth + 1)?;
                if let Some(output) = output {
                    chmod(&output, meta.mode() & 0o777)?;
                    sync(&output)?;
                }
            }
            kind if kind == libc::S_IFREG as u32 => {
                hash.update(b"f");
                let mut input = at(source, &entry, libc::O_RDONLY, 0)?;
                let meta = metadata(&input)?;
                owned(&meta)?;
                require(
                    meta.ino() == raw.st_ino as u64
                        && meta.dev() == raw.st_dev as u64
                        && meta.nlink() == 1,
                )?;
                budget.bytes = budget
                    .bytes
                    .checked_add(meta.len())
                    .ok_or(OtaError::Invalid)?;
                require(budget.bytes <= MAX_TREE_BYTES)?;
                hash.update((meta.mode() & 0o7777).to_be_bytes());
                hash.update(meta.len().to_be_bytes());
                let mut output = if let Some(output) = destination {
                    Some(at(
                        output,
                        &entry,
                        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                        0o600,
                    )?)
                } else {
                    None
                };
                let mut remaining = meta.len();
                let mut buffer = [0u8; 65536];
                while remaining > 0 {
                    let count = remaining.min(buffer.len() as u64) as usize;
                    input
                        .read_exact(&mut buffer[..count])
                        .map_err(|_| OtaError::Io)?;
                    hash.update(&buffer[..count]);
                    if let Some(output) = output.as_mut() {
                        output
                            .write_all(&buffer[..count])
                            .map_err(|_| OtaError::Io)?;
                    }
                    remaining -= count as u64;
                }
                let mut extra = [0u8; 1];
                require(input.read(&mut extra).map_err(|_| OtaError::Io)? == 0)?;
                unchanged(&meta, &metadata(&input)?)?;
                if let Some(output) = output {
                    chmod(&output, meta.mode() & 0o777)?;
                    sync(&output)?;
                }
            }
            kind if kind == libc::S_IFLNK as u32 => {
                hash.update(b"l");
                let entry_c = cstr(&entry)?;
                let mut bytes = [0u8; 4097];
                let length = unsafe {
                    libc::readlinkat(
                        source.as_raw_fd(),
                        entry_c.as_ptr(),
                        bytes.as_mut_ptr().cast(),
                        bytes.len(),
                    )
                };
                require(length > 0 && (length as usize) < bytes.len())?;
                let target = OsStr::from_bytes(&bytes[..length as usize]);
                let path = Path::new(target);
                require(
                    !path.is_absolute()
                        && path
                            .components()
                            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
                )?;
                record(hash, target.as_bytes());
                let after = stat_at(source, &entry)?;
                require(
                    raw.st_ino == after.st_ino
                        && raw.st_dev == after.st_dev
                        && raw.st_mtime == after.st_mtime
                        && raw.st_mtime_nsec == after.st_mtime_nsec
                        && raw.st_ctime == after.st_ctime,
                )?;
                if let Some(output) = destination {
                    let target = cstr(target)?;
                    if unsafe {
                        libc::symlinkat(target.as_ptr(), output.as_raw_fd(), entry_c.as_ptr())
                    } != 0
                    {
                        return Err(OtaError::Io);
                    }
                }
            }
            _ => return Err(OtaError::Identity),
        }
    }
    unchanged(&before, &metadata(source)?)?;
    if let Some(destination) = destination {
        sync(destination)?;
    }
    Ok(())
}
fn remove_verified_tree(directory: &File) -> Result<(), OtaError> {
    owned(&metadata(directory)?)?;
    for entry in entries(directory)? {
        let before = stat_at(directory, &entry)?;
        require(before.st_uid == unsafe { libc::geteuid() })?;
        let kind = before.st_mode as u32 & libc::S_IFMT as u32;
        let flags = if kind == libc::S_IFDIR as u32 {
            let child = at(directory, &entry, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            require(
                metadata(&child)?.ino() == before.st_ino
                    && metadata(&child)?.dev() == before.st_dev as u64,
            )?;
            remove_verified_tree(&child)?;
            libc::AT_REMOVEDIR
        } else if kind == libc::S_IFREG as u32 {
            let file = at(directory, &entry, libc::O_RDONLY, 0)?;
            let current = metadata(&file)?;
            owned(&current)?;
            require(
                current.ino() == before.st_ino
                    && current.dev() == before.st_dev as u64
                    && current.nlink() == 1,
            )?;
            0
        } else if kind == libc::S_IFLNK as u32 {
            0
        } else {
            return Err(OtaError::Identity);
        };
        let current = stat_at(directory, &entry)?;
        require(
            current.st_ino == before.st_ino
                && current.st_dev == before.st_dev
                && current.st_mode == before.st_mode,
        )?;
        let entry = cstr(&entry)?;
        if unsafe { libc::unlinkat(directory.as_raw_fd(), entry.as_ptr(), flags) } != 0 {
            return Err(OtaError::Io);
        }
    }
    sync(directory)
}
fn hash_tree(source: &File) -> Result<(String, u64), OtaError> {
    let mut hash = Sha256::new();
    hash.update(b"pacer-bundle-tree-v1\0");
    let mut budget = Budget::default();
    tree(source, None, &mut hash, &mut budget, 0)?;
    Ok((format!("{:x}", hash.finalize()), budget.bytes))
}
fn registration_parent(path: &Path, create: bool) -> Result<File, OtaError> {
    let parent = path.parent().ok_or(OtaError::Invalid)?;
    if create {
        match std::fs::symlink_metadata(parent) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let outer = open_dir(parent.parent().ok_or(OtaError::Invalid)?)?;
                owned(&metadata(&outer)?)?;
                let name = parent
                    .file_name()
                    .and_then(OsStr::to_str)
                    .ok_or(OtaError::Invalid)?;
                let _ = mkdir(&outer, name)?;
                sync(&outer)?;
            }
            Err(_) => return Err(OtaError::Identity),
            Ok(_) => {}
        }
    }
    let directory = open_dir(parent)?;
    owned(&metadata(&directory)?)?;
    require(parent.canonicalize().map_err(|_| OtaError::Identity)? == parent)?;
    Ok(directory)
}
pub(crate) fn publish_registration(path: &Path, bytes: &[u8]) -> Result<(), OtaError> {
    require(bytes.len() <= 131072)?;
    let parent = registration_parent(path, true)?;
    let entry = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(OtaError::Invalid)?;
    name(entry)?;
    match stat_at(&parent, OsStr::new(entry)) {
        Ok(_) => return require(read_owned_file(path, 131072)? == bytes),
        Err(_) if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let temporary = format!(".pacer-registration-{}", random_id()?);
    let mut file = at(
        &parent,
        OsStr::new(&temporary),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    private(&file, false)?;
    file.write_all(bytes).map_err(|_| OtaError::Io)?;
    sync(&file)?;
    same(
        &metadata(&parent)?,
        &metadata(&registration_parent(path, false)?)?,
    )?;
    rename_exclusive(&parent, &temporary, &parent, entry)?;
    require(read_owned_file(path, 131072)? == bytes)
}
pub(crate) fn remove_registration(path: &Path, bytes: &[u8]) -> Result<(), OtaError> {
    let parent = registration_parent(path, false)?;
    let entry = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(OtaError::Invalid)?;
    name(entry)?;
    let file = match at(&parent, OsStr::new(entry), libc::O_RDONLY, 0) {
        Ok(file) => file,
        Err(_) if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound => {
            return Ok(())
        }
        Err(error) => return Err(error),
    };
    private(&file, false)?;
    let before = metadata(&file)?;
    require(read_bounded(&file, 131072)? == bytes)?;
    same(
        &metadata(&parent)?,
        &metadata(&registration_parent(path, false)?)?,
    )?;
    let current = at(&parent, OsStr::new(entry), libc::O_RDONLY, 0)?;
    same(&before, &metadata(&current)?)?;
    unchanged(&before, &metadata(&file)?)?;
    let entry = name(entry)?;
    if unsafe { libc::unlinkat(parent.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
        return Err(OtaError::Io);
    }
    sync(&parent)
}
pub(crate) fn bundle_bytes(path: &Path) -> Result<u64, OtaError> {
    hash_tree(&open_dir(path)?).map(|(_, bytes)| bytes)
}
pub(crate) fn bundle_hash(path: &Path) -> Result<String, OtaError> {
    hash_tree(&open_dir(path)?).map(|(hash, _)| hash)
}
fn copy_verified(
    source: &File,
    parent: &File,
    entry: &str,
    expected: &str,
) -> Result<(), OtaError> {
    let (observed, size) = hash_tree(source)?;
    require(observed == expected)?;
    let mut space = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::fstatvfs(parent.as_raw_fd(), space.as_mut_ptr()) } != 0 {
        return Err(OtaError::Io);
    }
    let space = unsafe { space.assume_init() };
    require(
        (space.f_bavail as u128) * (space.f_frsize as u128) >= size as u128 + 16 * 1024 * 1024,
    )?;
    let output = mkdir(parent, entry)?;
    let mut hash = Sha256::new();
    hash.update(b"pacer-bundle-tree-v1\0");
    tree(source, Some(&output), &mut hash, &mut Budget::default(), 0)?;
    require(format!("{:x}", hash.finalize()) == expected)?;
    chmod(&output, metadata(source)?.mode() & 0o777)?;
    sync(&output)?;
    require(hash_tree(&output)?.0 == expected)?;
    sync(parent)
}

pub(crate) fn restore_bundle_private(
    assets: &PrivateDir,
    backup: &str,
    target: &Path,
    expected_backup: &str,
    current: Option<&str>,
) -> Result<(), OtaError> {
    restore_bundle_inner(assets, backup, target, expected_backup, current, true)
}

pub(crate) fn restore_bundle(
    assets: &PrivateDir,
    backup: &str,
    target: &Path,
    expected_backup: &str,
    current: Option<&str>,
) -> Result<(), OtaError> {
    restore_bundle_inner(assets, backup, target, expected_backup, current, false)
}
fn restore_bundle_inner(
    assets: &PrivateDir,
    backup: &str,
    target: &Path,
    expected_backup: &str,
    current: Option<&str>,
    private_staging: bool,
) -> Result<(), OtaError> {
    assets.current()?;
    name(backup)?;
    let source = at(
        &assets.directory,
        OsStr::new(backup),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?;
    require(hash_tree(&source)?.0 == expected_backup)?;
    let parent_path = target.parent().ok_or(OtaError::Invalid)?;
    let parent = open_dir(parent_path)?;
    owned(&metadata(&parent)?)?;
    let target_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(OtaError::Invalid)?;
    name(target_name)?;
    let old = match current {
        Some(expected) => {
            let old = at(
                &parent,
                OsStr::new(target_name),
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
            require(hash_tree(&old)?.0 == expected)?;
            Some(old)
        }
        None => {
            let result = stat_at(&parent, OsStr::new(target_name));
            if result.is_ok()
                || std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
            {
                return Err(OtaError::Identity);
            }
            None
        }
    };
    let staging_parent = if private_staging {
        require(metadata(&parent)?.dev() == metadata(&assets.directory)?.dev())?;
        &assets.directory
    } else {
        &parent
    };
    let staging = format!(".pacer-restore-{}", random_id()?);
    copy_verified(&source, staging_parent, &staging, expected_backup)?;
    assets.current()?;
    same(&metadata(&parent)?, &metadata(&open_dir(parent_path)?)?)?;
    if let Some(old) = old {
        let reopened = at(
            &parent,
            OsStr::new(target_name),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        same(&metadata(&old)?, &metadata(&reopened)?)?;
        require(hash_tree(&reopened)?.0 == current.unwrap())?;
        let retained = format!(".pacer-retained-{}", random_id()?);
        rename_exclusive(&parent, target_name, staging_parent, &retained)?;
        let moved = at(
            staging_parent,
            OsStr::new(&retained),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        same(&metadata(&old)?, &metadata(&moved)?)?;
    }
    rename_exclusive(staging_parent, &staging, &parent, target_name)?;
    let installed = at(
        &parent,
        OsStr::new(target_name),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?;
    require(hash_tree(&installed)?.0 == expected_backup)?;
    assets.current()
}
#[cfg(test)]
mod tests {
    #[test]
    fn fifo_asset_is_refused_without_waiting_for_a_writer() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("assets");
        let directory = super::PrivateDir::create(&path).unwrap();
        let file = std::ffi::CString::new(path.join("fifo").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(file.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = directory.read("fifo", 128);
            tx.send(result).unwrap();
            drop(temp);
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("special file read blocked")
            .is_err());
    }
    #[test]
    fn native_lock_owner_drop_unlocks_inherited_open_description() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let directory = super::PrivateDir::create(&root.join("locks")).unwrap();
        let first = directory.lock_named("ledger-lock").unwrap();
        let inherited = first._files[0].try_clone().unwrap();
        drop(first);
        assert!(directory.lock_named("ledger-lock").is_ok());
        drop(inherited);
    }
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn root() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("ota-fs-")
            .tempdir()
            .unwrap()
    }
    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().unwrap()
    }
    fn bundle(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        std::fs::write(path.join("Contents/MacOS/pacer"), bytes).unwrap();
        std::fs::set_permissions(
            path.join("Contents/MacOS/pacer"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    #[test]
    fn prune_only_exact_private_artifacts_and_preserve_mismatches_and_links() {
        let temp = root();
        let root = canonical(temp.path());
        let private = PrivateDir::create(&root.join("assets")).unwrap();
        let source = root.join("source.app");
        bundle(&source, b"old");
        let expected = bundle_hash(&source).unwrap();
        private
            .copy_bundle(&source, "previous.app", &expected)
            .unwrap();
        assert!(private
            .prune_bundle("previous.app", &"f".repeat(64))
            .is_err());
        assert!(private.path.join("previous.app").exists());
        private.prune_bundle("previous.app", &expected).unwrap();
        assert!(!private.path.join("previous.app").exists());
        assert!(source.exists());
        private.write_new("archive", b"signed").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"signed"));
        assert!(private.prune_file("archive", &"f".repeat(64)).is_err());
        private.prune_file("archive", &hash).unwrap();
        assert!(!private.path.join("archive").exists());
        symlink(&source, private.path.join("previous.app")).unwrap();
        assert!(private.prune_bundle("previous.app", &expected).is_err());
        assert!(source.exists());
    }
    #[test]
    fn persistent_registration_is_exclusive_and_removes_only_exact_owned_bytes() {
        let temp = root();
        let parent = canonical(temp.path());
        let path = parent.join("LaunchAgents/owned.plist");
        publish_registration(&path, b"owned").unwrap();
        assert_eq!(read_owned_file(&path, 20).unwrap(), b"owned");
        assert!(publish_registration(&path, b"foreign").is_err());
        assert!(remove_registration(&path, b"foreign").is_err());
        assert_eq!(read_owned_file(&path, 20).unwrap(), b"owned");
        remove_registration(&path, b"owned").unwrap();
        assert!(!path.exists());
        remove_registration(&path, b"owned").unwrap();
        let foreign = parent.join("foreign");
        std::fs::write(&foreign, b"sentinel").unwrap();
        symlink(&foreign, &path).unwrap();
        assert!(publish_registration(&path, b"owned").is_err());
        assert!(remove_registration(&path, b"sentinel").is_err());
        assert_eq!(std::fs::read(foreign).unwrap(), b"sentinel");
    }
    #[test]
    fn private_snapshot_replace_rejects_stale_bytes_and_named_lock_is_stable() {
        let temp = root();
        let private = PrivateDir::create(&canonical(temp.path()).join("private")).unwrap();
        private.write_new("record.json", b"old").unwrap();
        let held = private.lock_named("ledger-lock").unwrap();
        assert!(matches!(
            private.lock_named("ledger-lock"),
            Err(OtaError::Busy)
        ));
        assert!(private
            .replace_exact("record.json", b"stale", b"lost")
            .is_err());
        assert_eq!(private.read("record.json", 10).unwrap(), b"old");
        private
            .replace_exact("record.json", b"old", b"new")
            .unwrap();
        assert_eq!(private.read("record.json", 10).unwrap(), b"new");
        drop(held);
        assert!(private.lock_named("ledger-lock").is_ok());
    }
    #[test]
    fn archive_cache_derives_private_layout_and_rejects_wrong_content() {
        let temp = root();
        let home = canonical(temp.path());
        let cache = PrivateDir::downloads(&home, "installation").unwrap();
        assert_eq!(
            cache.path,
            home.join("desktop-updates/native/installation/downloads")
        );
        let bytes = b"signed candidate bytes";
        let hash = format!("{:x}", Sha256::digest(bytes));
        cache.store_archive(&hash, bytes).unwrap();
        cache.store_archive(&hash, bytes).unwrap();
        assert_eq!(cache.read_archive(&hash).unwrap(), bytes);
        assert!(cache.store_archive(&hash, b"changed").is_err());
        assert!(cache.read_archive("../outside").is_err());
        assert!(PrivateDir::downloads(&home, "../outside").is_err());
        std::fs::write(cache.path.join(format!("{hash}.tar.gz")), b"tampered").unwrap();
        assert!(cache.read_archive(&hash).is_err());
    }
    #[test]
    fn external_helper_is_exact_private_executable_and_never_overwrites_foreign_bytes() {
        let temp = root();
        let base = canonical(temp.path());
        let helper = base.join("source-helper");
        std::fs::write(&helper, b"verified helper").unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"verified helper"));
        let assets = PrivateDir::create(&base.join("assets")).unwrap();
        assets.stage_helper(&helper, &hash).unwrap();
        assets.stage_helper(&helper, &hash).unwrap();
        let staged = assets.path.join("pacer-update-helper");
        assert_eq!(
            std::fs::metadata(&staged).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        assert_eq!(std::fs::read(&staged).unwrap(), b"verified helper");
        std::fs::write(&staged, b"foreign").unwrap();
        assert!(assets.stage_helper(&helper, &hash).is_err());
        assert_eq!(std::fs::read(&staged).unwrap(), b"foreign");
    }
    #[test]
    fn private_assets_are_exclusive_bounded_and_durable() {
        let temp = root();
        let dir = PrivateDir::create(&canonical(temp.path()).join("assets")).unwrap();
        dir.write_new("artifact", b"signed artifact").unwrap();
        assert_eq!(dir.read("artifact", 100).unwrap(), b"signed artifact");
        assert!(dir.write_new("artifact", b"overwrite").is_err());
        assert!(dir.read("artifact", 2).is_err());
        assert!(dir.write_new("../escape", b"bad").is_err());
        assert_eq!(
            std::fs::metadata(dir.path.join("artifact"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );
        let path = dir.path.clone();
        drop(dir);
        assert_eq!(
            PrivateDir::open(&path)
                .unwrap()
                .read("artifact", 100)
                .unwrap(),
            b"signed artifact"
        );
    }
    #[test]
    fn aliases_share_locks_and_two_installations_share_home_lock() {
        let temp = root();
        let dir = PrivateDir::create(&canonical(temp.path()).join("locks")).unwrap();
        let app = canonical(temp.path()).join("pacer.app");
        let other = canonical(temp.path()).join("other.app");
        let home = canonical(temp.path());
        let first = dir.acquire_locks(&app, &home).unwrap();
        assert!(matches!(
            dir.acquire_locks(&app, &home),
            Err(OtaError::Busy)
        ));
        assert!(matches!(
            dir.acquire_locks(&other, &home),
            Err(OtaError::Busy)
        ));
        drop(first);
        assert!(dir.acquire_locks(&app, &home).is_ok());
    }
    #[test]
    fn symlink_hardlink_and_replaced_root_are_refused_without_damage() {
        let temp = root();
        let base = canonical(temp.path());
        let dir = PrivateDir::create(&base.join("assets")).unwrap();
        std::fs::write(base.join("outside"), b"untouched").unwrap();
        symlink(base.join("outside"), dir.path.join("link")).unwrap();
        assert!(dir.read("link", 100).is_err());
        dir.write_new("file", b"private").unwrap();
        std::fs::hard_link(dir.path.join("file"), dir.path.join("alias")).unwrap();
        assert!(dir.read("file", 100).is_err());
        std::fs::rename(&dir.path, base.join("moved")).unwrap();
        std::fs::create_dir(&dir.path).unwrap();
        std::fs::set_permissions(&dir.path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(dir.write_new("new", b"bad").is_err());
        assert!(!dir.path.join("new").exists());
        assert_eq!(std::fs::read(base.join("outside")).unwrap(), b"untouched");
    }
    #[test]
    fn private_restore_retains_candidate_inside_transaction_without_new_root_entries() {
        let temp = root();
        let base = canonical(temp.path());
        let app = base.join("current.app");
        bundle(&app, b"old");
        let old = bundle_hash(&app).unwrap();
        let assets = PrivateDir::create(&base.join("transaction")).unwrap();
        assets.copy_bundle(&app, "previous.app", &old).unwrap();
        std::fs::write(app.join("Contents/MacOS/pacer"), b"candidate").unwrap();
        let candidate = bundle_hash(&app).unwrap();
        let mut before: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .map(|v| v.unwrap().file_name())
            .collect();
        before.sort();
        restore_bundle_private(&assets, "previous.app", &app, &old, Some(&candidate)).unwrap();
        let mut after: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .map(|v| v.unwrap().file_name())
            .collect();
        after.sort();
        assert_eq!(before, after);
        let retained = std::fs::read_dir(&assets.path)
            .unwrap()
            .filter_map(|v| {
                let p = v.unwrap().path();
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".pacer-retained-")
                    .then_some(p)
            })
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), 1);
        assert_eq!(bundle_hash(&retained[0]).unwrap(), candidate);
        assert_eq!(bundle_hash(&app).unwrap(), old);
    }
    #[test]
    fn complete_backup_roundtrips_modes_links_and_leaves_user_data_untouched() {
        let temp = root();
        let base = canonical(temp.path());
        let app = base.join("pacer.app");
        bundle(&app, b"old");
        symlink("MacOS/pacer", app.join("Contents/current")).unwrap();
        let hash = bundle_hash(&app).unwrap();
        let assets = PrivateDir::create(&base.join("assets")).unwrap();
        assets.copy_bundle(&app, "previous.app", &hash).unwrap();
        assert_eq!(
            bundle_hash(&assets.path.join("previous.app")).unwrap(),
            hash
        );
        assert!(assets.copy_bundle(&app, "previous.app", &hash).is_err());
        std::fs::write(base.join("user-data"), b"must remain").unwrap();
        std::fs::write(app.join("Contents/MacOS/pacer"), b"candidate").unwrap();
        let candidate = bundle_hash(&app).unwrap();
        restore_bundle(&assets, "previous.app", &app, &hash, Some(&candidate)).unwrap();
        assert_eq!(bundle_hash(&app).unwrap(), hash);
        assert_eq!(
            std::fs::read(base.join("user-data")).unwrap(),
            b"must remain"
        );
        assert_eq!(
            bundle_hash(&assets.path.join("previous.app")).unwrap(),
            hash
        );
    }
    #[test]
    fn escaping_links_changed_hash_and_foreign_target_refuse_before_replacement() {
        let temp = root();
        let base = canonical(temp.path());
        let app = base.join("pacer.app");
        bundle(&app, b"old");
        let hash = bundle_hash(&app).unwrap();
        let assets = PrivateDir::create(&base.join("assets")).unwrap();
        assert!(assets
            .copy_bundle(&app, "bad.app", &"0".repeat(64))
            .is_err());
        assert!(!assets.path.join("bad.app").exists());
        assets.copy_bundle(&app, "previous.app", &hash).unwrap();
        std::fs::write(app.join("Contents/MacOS/pacer"), b"foreign").unwrap();
        assert!(restore_bundle(&assets, "previous.app", &app, &hash, Some(&hash)).is_err());
        assert_eq!(
            std::fs::read(app.join("Contents/MacOS/pacer")).unwrap(),
            b"foreign"
        );
        symlink("../../outside", app.join("Contents/escape")).unwrap();
        assert!(bundle_hash(&app).is_err());
    }
}

/// Caller holds app/home transaction locks; replaces one independently verified registration.
pub(crate) fn replace_registration(
    path: &Path,
    expected: &[u8],
    next: &[u8],
) -> Result<(), OtaError> {
    require(
        !expected.is_empty()
            && expected.len() <= 131072
            && !next.is_empty()
            && next.len() <= 131072,
    )?;
    let parent = registration_parent(path, false)?;
    let entry = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(OtaError::Invalid)?;
    name(entry)?;
    let old = at(
        &parent,
        OsStr::new(entry),
        libc::O_RDONLY | libc::O_NONBLOCK,
        0,
    )?;
    private(&old, false)?;
    let before = metadata(&old)?;
    let bytes = read_bounded(&old, 131072)?;
    require(bytes == expected || bytes == next)?;
    same(
        &metadata(&parent)?,
        &metadata(&registration_parent(path, false)?)?,
    )?;
    let current = at(
        &parent,
        OsStr::new(entry),
        libc::O_RDONLY | libc::O_NONBLOCK,
        0,
    )?;
    unchanged(&before, &metadata(&current)?)?;
    if bytes == next {
        return Ok(());
    }
    let temporary = format!(".pacer-registration-{}", random_id()?);
    let mut file = at(
        &parent,
        OsStr::new(&temporary),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    private(&file, false)?;
    file.write_all(next).map_err(|_| OtaError::Io)?;
    sync(&file)?;
    same(
        &metadata(&parent)?,
        &metadata(&registration_parent(path, false)?)?,
    )?;
    let current = at(
        &parent,
        OsStr::new(entry),
        libc::O_RDONLY | libc::O_NONBLOCK,
        0,
    )?;
    unchanged(&before, &metadata(&current)?)?;
    require(read_bounded(&current, 131072)? == expected)?;
    unchanged(&before, &metadata(&old)?)?;
    let source = name(&temporary)?;
    let destination = name(entry)?;
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            source.as_ptr(),
            parent.as_raw_fd(),
            destination.as_ptr(),
        )
    } != 0
    {
        return Err(OtaError::Io);
    }
    sync(&parent)?;
    same(
        &metadata(&parent)?,
        &metadata(&registration_parent(path, false)?)?,
    )?;
    let published = at(
        &parent,
        OsStr::new(entry),
        libc::O_RDONLY | libc::O_NONBLOCK,
        0,
    )?;
    private(&published, false)?;
    same(&metadata(&file)?, &metadata(&published)?)?;
    require(read_bounded(&published, 131072)? == next)
}

#[cfg(test)]
mod registration_replace_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap().join("LaunchAgents");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = parent.join("fixture.plist");
        std::fs::write(&path, b"original").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        (temp, path)
    }
    #[test]
    fn exact_registration_switch_is_atomic_private_and_idempotent() {
        let (_temp, path) = fixture();
        let old = File::open(&path).unwrap();
        replace_registration(&path, b"original", b"managed").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"managed");
        let mut original = Vec::new();
        (&old).read_to_end(&mut original).unwrap();
        assert_eq!(original, b"original");
        let inode = std::fs::metadata(&path).unwrap().ino();
        replace_registration(&path, b"original", b"managed").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
        replace_registration(&path, b"managed", b"original").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }
    #[test]
    fn mismatch_redirect_hardlink_and_unsafe_parent_are_retained() {
        let (_temp, path) = fixture();
        assert!(replace_registration(&path, b"wrong", b"managed").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        let outside = path.parent().unwrap().join("outside");
        std::fs::rename(&path, &outside).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(replace_registration(&path, b"original", b"managed").is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"original");
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&outside, &path).unwrap();
        assert!(replace_registration(&path, b"original", b"managed").is_err());
        std::fs::remove_file(&outside).unwrap();
        std::fs::set_permissions(
            path.parent().unwrap(),
            std::fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        assert!(replace_registration(&path, b"original", b"managed").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
    }
}
