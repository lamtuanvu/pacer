//! Descriptor-relative private save: link for create, rename for overwrite.
use pacer_foundation::Ctx;
use rustix::{
    fs::{
        AtFlags, CWD, FileType, Mode, OFlags, linkat, mkdirat, openat, renameat, statat, unlinkat,
    },
    io::Errno,
};
use std::{
    fs::File,
    io::{self, Write},
};

fn regular_or_missing(dir: &File, name: &str) -> io::Result<bool> {
    match statat(dir, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) if FileType::from_raw_mode(stat.st_mode).is_file() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "strategy file is not a regular file",
        )),
        Err(Errno::NOENT) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn save_named(ctx: &Ctx, name: &str, content: &[u8], overwrite: bool) -> io::Result<()> {
    let pacer = File::from(openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    match mkdirat(&pacer, "strategies", Mode::from_bits_retain(0o700)) {
        Ok(()) | Err(Errno::EXIST) => {}
        Err(error) => return Err(error.into()),
    }
    let dir = File::from(openat(
        &pacer,
        "strategies",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        dir.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    let target = format!("{name}.yaml");
    if regular_or_missing(&dir, &target)? && !overwrite {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("strategy \"{name}\" already exists"),
        ));
    }
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let temp = format!("{target}.{:016x}.tmp", u64::from_le_bytes(random));
    let mut file = File::from(openat(
        &dir,
        temp.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_retain(0o600),
    )?);
    let result = file.write_all(content).and_then(|()| {
        if regular_or_missing(&dir, &target)? && !overwrite {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("strategy \"{name}\" already exists"),
            ));
        }
        if overwrite {
            renameat(&dir, temp.as_str(), &dir, target.as_str()).map_err(Into::into)
        } else {
            linkat(&dir, temp.as_str(), &dir, target.as_str(), AtFlags::empty()).map_err(Into::into)
        }
    });
    drop(file);
    let _ = unlinkat(&dir, temp.as_str(), AtFlags::empty());
    result
}
