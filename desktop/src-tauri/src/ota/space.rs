//! Conservative storage headroom before stopping an owned installation.
use super::OtaError;
use std::{
    fs::File,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawFd, FromRawFd},
    },
    path::Path,
};

const MARGIN: u64 = 256 * 1024 * 1024;
fn required(old: u64, candidate: u64) -> Result<u64, OtaError> {
    // Target: candidate extraction, retained partial candidate and old restore
    // staging. Private storage: old backup. Count both even on separate devices:
    // APFS volumes can share a free-space pool despite different device IDs.
    old.checked_mul(2)
        .and_then(|n| candidate.checked_mul(2).and_then(|c| n.checked_add(c)))
        .and_then(|n| n.checked_add(2 * MARGIN))
        .ok_or(OtaError::Invalid)
}
fn directory(path: &Path, owned: bool) -> Result<File, OtaError> {
    if path.canonicalize().map_err(|_| OtaError::Identity)? != path {
        return Err(OtaError::Identity);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| OtaError::Io)?;
    let info = file.metadata().map_err(|_| OtaError::Io)?;
    if !info.is_dir()
        || info.mode() & 0o222 == 0
        || info.mode() & 0o111 == 0
        || (owned && (info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o700 != 0o700))
    {
        return Err(OtaError::Identity);
    }
    #[cfg(target_os = "macos")]
    {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(OtaError::Io);
        }
        if unsafe { stat.assume_init() }.st_flags
            & (libc::UF_IMMUTABLE | libc::SF_IMMUTABLE | libc::UF_APPEND | libc::SF_APPEND)
            != 0
        {
            return Err(OtaError::Identity);
        }
    }
    unchanged(path, &file)?;
    Ok(file)
}
fn unchanged(path: &Path, file: &File) -> Result<(), OtaError> {
    let current = std::fs::symlink_metadata(path).map_err(|_| OtaError::Identity)?;
    let held = file.metadata().map_err(|_| OtaError::Io)?;
    if !current.is_dir()
        || current.dev() != held.dev()
        || current.ino() != held.ino()
        || path.canonicalize().map_err(|_| OtaError::Identity)? != path
    {
        return Err(OtaError::Identity);
    }
    Ok(())
}
fn available(file: &File) -> Result<u64, OtaError> {
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::fstatvfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(OtaError::Io);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.f_flag & libc::ST_RDONLY != 0 || stat.f_frsize == 0 {
        return Err(OtaError::Identity);
    }
    u64::try_from((stat.f_bavail as u128) * (stat.f_frsize as u128)).map_err(|_| OtaError::Invalid)
}
fn writable(file: &File) -> Result<(), OtaError> {
    let mut random = [0u8; 16];
    if unsafe { libc::getentropy(random.as_mut_ptr().cast(), random.len()) } != 0 {
        return Err(OtaError::Io);
    }
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let name =
        std::ffi::CString::new(format!(".pacer-space-{suffix}")).map_err(|_| OtaError::Invalid)?;
    let fd = unsafe {
        libc::openat(
            file.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(OtaError::Io);
    }
    let probe = unsafe { File::from_raw_fd(fd) };
    let info = probe.metadata().map_err(|_| OtaError::Io)?;
    let mut entry = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            file.as_raw_fd(),
            name.as_ptr(),
            entry.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(OtaError::Identity);
    }
    let entry = unsafe { entry.assume_init() };
    if entry.st_ino != info.ino() || entry.st_dev as u64 != info.dev() || entry.st_nlink != 1 {
        return Err(OtaError::Identity);
    }
    if unsafe { libc::unlinkat(file.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(OtaError::Io);
    }
    Ok(())
}
/// This is a refusal preflight, not a space reservation. The installer must
/// still handle races and retain its verified backup when another writer fills
/// the disk after this check.
pub(crate) fn verify(
    app: &Path,
    old_bytes: u64,
    candidate_bytes: u64,
    private_dir: &Path,
) -> Result<(), OtaError> {
    let needed = required(old_bytes, candidate_bytes)?;
    let parent = app.parent().ok_or(OtaError::Invalid)?;
    let target = directory(app, true)?;
    let destination = directory(parent, false)?;
    let private = directory(private_dir, true)?;
    for file in [&target, &destination, &private] {
        if available(file)? < needed {
            return Err(OtaError::Io);
        }
    }
    // Prove create/remove permissions only in the two directories we own for
    // publication. Never modify the signed app as a permissions probe.
    writable(&destination)?;
    writable(&private)?;
    unchanged(app, &target)?;
    unchanged(parent, &destination)?;
    unchanged(private_dir, &private)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn refuses_unaffordable_install_and_restore_without_mutating_the_app() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let app = root.join("pacer.app");
        let private = root.join("private");
        std::fs::create_dir(&app).unwrap();
        std::fs::create_dir(&private).unwrap();
        std::fs::write(app.join("sentinel"), b"unchanged").unwrap();
        assert!(verify(&app, u64::MAX, u64::MAX, &private).is_err());
        assert!(verify(&app, 1 << 60, 1 << 60, &private).is_err());
        assert_eq!(std::fs::read(app.join("sentinel")).unwrap(), b"unchanged");
        assert!(verify(&app, 1024, 2048, &private).is_ok());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
    }
    #[test]
    fn refuses_readonly_or_redirected_destination_before_stopping_anything() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let app = root.join("pacer.app");
        let private = root.join("private");
        std::fs::create_dir(&app).unwrap();
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(verify(&app, 1024, 2048, &private).is_err());
        std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o700)).unwrap();
        let alias = root.join("alias.app");
        symlink(&app, &alias).unwrap();
        assert!(verify(&alias, 1024, 2048, &private).is_err());
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = verify(&app, 1024, 2048, &private);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
    }
}
