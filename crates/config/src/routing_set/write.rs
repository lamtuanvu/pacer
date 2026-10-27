//! Descriptor-relative private replacement for the strategy and OpenCode cache.
use pacer_foundation::Ctx;
use rustix::{
    fs::{AtFlags, CWD, FileType, Mode, OFlags, mkdirat, openat, renameat, statat, unlinkat},
    io::Errno,
};
use std::{
    fs::File,
    io::{self, Read, Write},
};

fn pacer(ctx: &Ctx) -> io::Result<File> {
    let dir = File::from(openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        dir.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

fn regular_or_missing(dir: &File, name: &str) -> io::Result<bool> {
    match statat(dir, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) if FileType::from_raw_mode(stat.st_mode).is_file() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "state target is not a regular file",
        )),
        Err(Errno::NOENT) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn read_regular(dir: &File, name: &str) -> io::Result<Option<(File, Vec<u8>)>> {
    if !regular_or_missing(dir, name)? {
        return Ok(None);
    }
    let mut file = File::from(openat(
        dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "state target is not a bounded file",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "state target exceeds byte limit",
        ));
    }
    Ok(Some((file, bytes)))
}

fn replace(dir: &File, name: &str, bytes: &[u8]) -> io::Result<()> {
    regular_or_missing(dir, name)?;
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let temp = format!("{name}.{:016x}.tmp", u64::from_le_bytes(random));
    let mut file = File::from(openat(
        dir,
        temp.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_retain(0o600),
    )?);
    let result = file.write_all(bytes).and_then(|()| {
        regular_or_missing(dir, name)?;
        renameat(dir, temp.as_str(), dir, name).map_err(Into::into)
    });
    drop(file);
    let _ = unlinkat(dir, temp.as_str(), AtFlags::empty());
    result
}

pub(super) fn replace_strategy(
    ctx: &Ctx,
    active: &str,
    before: &str,
    after: &[u8],
) -> io::Result<()> {
    let pacer = pacer(ctx)?;
    let (dir, name) = if active == "default" {
        (pacer, "strategy.yaml".to_owned())
    } else {
        let dir = File::from(openat(
            &pacer,
            "strategies",
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        (dir, format!("{active}.yaml"))
    };
    let (_, current) = read_regular(&dir, &name)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "strategy disappeared"))?;
    if current != before.as_bytes() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "strategy changed during edit",
        ));
    }
    replace(&dir, &name, after)
}

pub(super) fn refresh_opencode(ctx: &Ctx, content: &[u8]) -> io::Result<()> {
    let pacer = pacer(ctx)?;
    match mkdirat(&pacer, "opencode", Mode::from_bits_retain(0o700)) {
        Ok(()) | Err(Errno::EXIST) => {}
        Err(error) => return Err(error.into()),
    }
    let dir = File::from(openat(
        &pacer,
        "opencode",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        dir.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    if let Some((file, current)) = read_regular(&dir, "opencode.json")? {
        if current == content {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            return Ok(());
        }
    }
    replace(&dir, "opencode.json", content)
}
