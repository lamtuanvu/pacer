//! Service argv derivation for the native front door.
//!
//! Mirrors `nativeServiceArgv` in `src/update/desktop/native-service-argv.ts`:
//! the current executable's canonical path followed by the original arguments.
//! Bun's compiled argv begins with `bun` and its virtual entrypoint; the signed
//! executable has already been independently verified by the native provider.
use std::{env, io, path::PathBuf};

/// The front door's canonical executable and original arguments
/// (`realpath(process.execPath)` + `process.argv.slice(2)`).
pub fn native_service_argv() -> io::Result<Vec<String>> {
    let executable = current_executable_canonical()?;
    let mut argv = Vec::with_capacity(env::args_os().len());
    argv.push(executable);
    for argument in env::args_os().skip(1) {
        argv.push(
            argument
                .into_string()
                .map_err(|_| io::Error::other("native service argv is not valid UTF-8"))?,
        );
    }
    Ok(argv)
}

#[cfg(unix)]
fn current_executable_canonical() -> io::Result<String> {
    let path = env::current_exe()?;
    let canonical = std::fs::canonicalize(&path)?;
    canonical
        .into_os_string()
        .into_string()
        .map_err(|_| io::Error::other("native service executable is not valid UTF-8"))
}

#[cfg(not(unix))]
fn current_executable_canonical() -> io::Result<String> {
    Err(io::Error::other(
        "native service requires a supported platform",
    ))
}

/// Test helper producing the canonical current executable without reading argv.
pub fn current_executable() -> io::Result<PathBuf> {
    Ok(PathBuf::from(current_executable_canonical()?))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn current_executable_is_absolute_canonical() {
        let path = current_executable().unwrap();
        assert!(path.is_absolute());
        assert_eq!(path, std::fs::canonicalize(&path).unwrap());
    }
}
