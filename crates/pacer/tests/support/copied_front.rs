use std::{io, process::Output, thread, time::Duration};

pub fn copied_front_version(executable: &std::path::Path) -> io::Result<Output> {
    retry_version_start(|| {
        std::process::Command::new(executable)
            .arg("--version")
            .output()
    })
}
fn retry_version_start(mut start: impl FnMut() -> io::Result<Output>) -> io::Result<Output> {
    // Only fixture metadata startup is retried. No child was created when
    // exec returns ETXTBSY, and no release-base/security assertion is rerun.
    let mut result = start();
    for _ in 1..20 {
        if !matches!(&result,Err(error) if error.raw_os_error()==Some(26)) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
        result = start();
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_transient_text_busy_retries_before_native_version_starts() {
        let mut attempts = 0;
        let result = retry_version_start(|| {
            attempts += 1;
            if attempts < 3 {
                Err(io::Error::from_raw_os_error(26))
            } else {
                std::process::Command::new("/bin/echo")
                    .arg("fixture version")
                    .output()
            }
        })
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(result.stdout, b"fixture version\n");
    }
    #[test]
    fn permission_failure_never_retries() {
        let mut attempts = 0;
        let error = retry_version_start(|| {
            attempts += 1;
            Err(io::Error::from_raw_os_error(13))
        })
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(13));
        assert_eq!(attempts, 1);
    }
    #[test]
    fn persistent_text_busy_is_bounded_and_preserves_os_error() {
        let mut attempts = 0;
        let error = retry_version_start(|| {
            attempts += 1;
            Err(io::Error::from_raw_os_error(26))
        })
        .unwrap_err();
        assert_eq!(attempts, 20);
        assert_eq!(error.raw_os_error(), Some(26));
    }
    #[test]
    fn started_command_failure_is_not_retried() {
        let mut attempts = 0;
        let result = retry_version_start(|| {
            attempts += 1;
            std::process::Command::new("/usr/bin/false").output()
        })
        .unwrap();
        assert!(!result.status.success());
        assert_eq!(attempts, 1);
    }
}

#[cfg(all(test, target_os = "linux"))]
#[test]
fn linux_actual_write_handle_blocks_exec_then_version_succeeds_after_close() {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "pacer-copy-version-{}-{unique}",
        std::process::id()
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let executable = directory.join("pacer");
    std::fs::copy("/bin/echo", &executable).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&executable)
        .unwrap();
    assert_eq!(
        std::process::Command::new(&executable)
            .arg("--version")
            .output()
            .unwrap_err()
            .raw_os_error(),
        Some(26)
    );
    let release = std::thread::spawn(move || {
        thread::sleep(Duration::from_millis(40));
        drop(writer);
    });
    let result = copied_front_version(&executable).unwrap();
    release.join().unwrap();
    assert!(result.status.success());
    assert!(!result.stdout.is_empty());
    std::fs::remove_dir_all(directory).unwrap();
}
