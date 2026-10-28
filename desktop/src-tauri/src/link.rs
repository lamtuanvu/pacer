use serde::{Deserialize, Serialize};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;
use sha2::{Digest, Sha256};

fn matches_takeover_identity(path: &Path, expected: &pacer_desktop::ota::bootstrap_identity::LegacyExecutable) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.dev().to_string() != expected.device
        || metadata.ino().to_string() != expected.inode || metadata.len() != expected.size { return Ok(false) }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)) == expected.sha256)
}

pub fn relink_after_takeover(home: &Path, bundled: &Path, expected: &pacer_desktop::ota::bootstrap_identity::LegacyExecutable, now: SystemTime) -> Result<PathBuf, String> {
    let link = link_path(home);
    if !matches_takeover_identity(&link, expected)? { return Err("The terminal command changed since confirmation".into()) }
    let seconds = now.duration_since(SystemTime::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let stamp = unsafe {
        let raw = seconds as libc::time_t;
        let mut utc: libc::tm = std::mem::zeroed();
        if libc::gmtime_r(&raw, &mut utc).is_null() { return Err("Unable to format backup time".into()) }
        format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec)
    };
    let backup = link.with_file_name(format!("pacer.pre-app-{stamp}"));
    if fs::symlink_metadata(&backup).is_ok() { return Err("The terminal backup already exists".into()) }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let old = CString::new(link.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let new = CString::new(backup.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        if unsafe { libc::renamex_np(old.as_ptr(), new.as_ptr(), libc::RENAME_EXCL) } != 0 { return Err(std::io::Error::last_os_error().to_string()) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Exclusive hard link prevents overwriting an existing backup.
        fs::hard_link(&link, &backup).map_err(|e| e.to_string())?;
        fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    // The move may have raced a write. Never link to the app if the backed-up file changed.
    let backed = fs::symlink_metadata(&backup).map_err(|e| e.to_string())?;
    use std::os::unix::fs::MetadataExt;
    if !backed.is_file() || backed.dev().to_string() != expected.device || backed.ino().to_string() != expected.inode || backed.len() != expected.size
        || format!("{:x}", Sha256::digest(fs::read(&backup).map_err(|e| e.to_string())?)) != expected.sha256 {
        return Err("The terminal command changed during backup".into());
    }
    symlink(bundled, &link).map_err(|e| e.to_string())?;
    Ok(backup)
}

#[derive(Debug, PartialEq, Eq)]
pub enum LinkState {
    Missing,
    Ours,
    Broken,
    Foreign(PathBuf),
}

pub fn link_path(home: &Path) -> PathBuf {
    home.join(".local/bin/pacer")
}

pub fn state(home: &Path, bundled: &Path) -> LinkState {
    let link = link_path(home);
    match fs::symlink_metadata(&link) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return LinkState::Missing,
        Ok(metadata) if metadata.is_symlink() => {}
        _ => return LinkState::Foreign(link),
    }
    let target = match fs::read_link(&link) {
        Ok(target) => target,
        Err(_) => return LinkState::Foreign(link),
    };
    if target == bundled {
        return LinkState::Ours;
    }
    let resolved = link.parent().unwrap().join(&target);
    let inside_app = resolved.ancestors().skip(1).any(|parent| {
        parent
            .extension()
            .is_some_and(|extension| extension == "app")
    });
    if inside_app && matches!(resolved.try_exists(), Ok(false)) {
        LinkState::Broken
    } else {
        LinkState::Foreign(target)
    }
}

pub fn create(home: &Path, bundled: &Path, replace_foreign: bool) -> Result<(), String> {
    let link = link_path(home);
    match state(home, bundled) {
        LinkState::Ours => return Ok(()),
        LinkState::Missing => {
            let bin = link.parent().unwrap();
            if !bin.exists() {
                DirBuilder::new()
                    .recursive(true)
                    .mode(0o755)
                    .create(bin)
                    .map_err(|error| error.to_string())?;
                fs::set_permissions(bin, fs::Permissions::from_mode(0o755))
                    .map_err(|error| error.to_string())?;
            }
        }
        LinkState::Broken => fs::remove_file(&link).map_err(|error| error.to_string())?,
        LinkState::Foreign(_) => {
            if !replace_foreign {
                return Err("~/.local/bin/pacer already exists".into());
            }
            let backup = link.with_file_name("pacer.pre-app");
            match fs::symlink_metadata(&backup) {
                Ok(_) => return Err("~/.local/bin/pacer.pre-app already exists".into()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            fs::rename(&link, &backup).map_err(|error| error.to_string())?;
        }
    }
    // symlink fails if another entry appeared; never replace it implicitly.
    symlink(bundled, &link).map_err(|error| error.to_string())
}

#[derive(Serialize, Deserialize)]
pub struct KeepMine {
    pub path: String,
    pub version: String,
}

pub fn remembered(config_dir: &Path, path: &str, version: &str) -> bool {
    let Ok(contents) = fs::read(config_dir.join("cli-choice.json")) else {
        return false;
    };
    let Ok(choice) = serde_json::from_slice::<KeepMine>(&contents) else {
        return false;
    };
    choice.path == path && choice.version == version
}

pub fn remember(config_dir: &Path, choice: &KeepMine) -> Result<(), String> {
    let contents = serde_json::to_vec(choice).map_err(|error| error.to_string())?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(config_dir)
        .map_err(|error| error.to_string())?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = config_dir.join(format!(
        ".pacer-choice-{}-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        file.write_all(&contents)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        fs::rename(&temp, config_dir.join("cli-choice.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error: io::Error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn expected(path: &Path) -> pacer_desktop::ota::bootstrap_identity::LegacyExecutable {
        let m = fs::symlink_metadata(path).unwrap();
        pacer_desktop::ota::bootstrap_identity::LegacyExecutable {
            device: m.dev().to_string(), inode: m.ino().to_string(), size: m.len(), modified_ns: "0".into(), changed_ns: "0".into(),
            sha256: format!("{:x}", Sha256::digest(fs::read(path).unwrap())), cdhash: "a".repeat(40),
        }
    }

    #[test]
    fn takeover_relink_backs_up_exact_file_and_never_follows_a_symlink() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        fs::write(&link, "other build").unwrap();
        let identity = expected(&link);
        let now = SystemTime::UNIX_EPOCH;
        let backup = relink_after_takeover(&dir.0, &bundled, &identity, now).unwrap();
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("pacer.pre-app-"));
        assert_eq!(fs::read(&backup).unwrap(), b"other build");
        assert_eq!(fs::read_link(&link).unwrap(), bundled);
        assert!(relink_after_takeover(&dir.0, &bundled, &identity, now).is_err());
    }

    #[test]
    fn takeover_relink_rejects_changed_content_inode_and_existing_backup() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        fs::write(&link, "other build").unwrap();
        let identity = expected(&link);
        let now = SystemTime::UNIX_EPOCH;
        fs::write(&link, "changed").unwrap();
        assert!(relink_after_takeover(&dir.0, &bundled, &identity, now).is_err());
        fs::remove_file(&link).unwrap();
        fs::write(&link, "other build").unwrap();
        assert!(relink_after_takeover(&dir.0, &bundled, &identity, now).is_err());
        let new_identity = expected(&link);
        let backup = link.with_file_name("pacer.pre-app-19700101T000000Z");
        fs::write(&backup, "existing").unwrap();
        assert!(relink_after_takeover(&dir.0, &bundled, &new_identity, now).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"existing");
        assert_eq!(fs::read(&link).unwrap(), b"other build");
        fs::remove_file(&link).unwrap();
        symlink(&backup, &link).unwrap();
        assert!(relink_after_takeover(&dir.0, &bundled, &new_identity, now).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"existing");
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "pacer-link-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn bundled(&self) -> PathBuf {
            let path = self.0.join("pacer.app/Contents/MacOS/pacer");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "bundled").unwrap();
            path
        }

        fn link(&self) -> PathBuf {
            let path = self.0.join(".local/bin/pacer");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn state_distinguishes_missing_ours_and_regular_file() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        assert_eq!(link_path(&dir.0), link);
        assert_eq!(state(&dir.0, &bundled), LinkState::Missing);
        symlink(&bundled, &link).unwrap();
        assert_eq!(state(&dir.0, &bundled), LinkState::Ours);
        fs::remove_file(&link).unwrap();
        fs::write(&link, "foreign").unwrap();
        assert_eq!(state(&dir.0, &bundled), LinkState::Foreign(link));
    }

    #[test]
    fn state_distinguishes_broken_app_links_from_foreign_targets() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        for (target, broken) in [
            (dir.0.join("gone.app/Contents/MacOS/pacer"), true),
            (PathBuf::from("../../gone.app/Contents/MacOS/pacer"), true),
            (dir.0.join("gone.app-backup/pacer"), false),
            (dir.0.join("missing-cli"), false),
            (dir.0.join("other.app/Contents/MacOS/pacer"), false),
        ] {
            if target.starts_with(dir.0.join("other.app")) {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(&target, "other").unwrap();
            }
            symlink(&target, &link).unwrap();
            let expected = if broken {
                LinkState::Broken
            } else {
                LinkState::Foreign(target)
            };
            assert_eq!(state(&dir.0, &bundled), expected);
            fs::remove_file(&link).unwrap();
        }
    }

    #[test]
    fn create_makes_missing_parent_and_link_with_public_directory_mode() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        create(&dir.0, &bundled, false).unwrap();
        assert_eq!(
            fs::read_link(dir.0.join(".local/bin/pacer")).unwrap(),
            bundled
        );
        assert_eq!(
            fs::metadata(dir.0.join(".local/bin"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[test]
    fn create_repairs_broken_app_link() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        symlink(dir.0.join("gone.app/Contents/MacOS/pacer"), &link).unwrap();
        create(&dir.0, &bundled, false).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), bundled);
        assert!(!link.with_file_name("pacer.pre-app").exists());
    }

    #[test]
    fn create_keeps_our_link_and_existing_directory_mode() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        symlink(&bundled, &link).unwrap();
        let inode = fs::symlink_metadata(&link).unwrap().ino();
        fs::set_permissions(link.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        create(&dir.0, &bundled, true).unwrap();
        assert_eq!(fs::symlink_metadata(&link).unwrap().ino(), inode);
        assert_eq!(
            fs::metadata(link.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[test]
    fn create_refuses_foreign_file_without_consent() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        fs::write(&link, "original").unwrap();
        assert_eq!(
            create(&dir.0, &bundled, false),
            Err("~/.local/bin/pacer already exists".into())
        );
        assert_eq!(fs::read_to_string(&link).unwrap(), "original");
    }

    #[test]
    fn create_backs_up_foreign_file_before_replacing_it() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        fs::write(&link, "original").unwrap();
        create(&dir.0, &bundled, true).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), bundled);
        assert_eq!(
            fs::read_to_string(link.with_file_name("pacer.pre-app")).unwrap(),
            "original"
        );
    }

    #[test]
    fn create_preserves_a_foreign_symlink_in_the_backup() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        let target = dir.0.join("external-cli");
        symlink(&target, &link).unwrap();
        assert!(create(&dir.0, &bundled, false).is_err());
        create(&dir.0, &bundled, true).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), bundled);
        assert_eq!(
            fs::read_link(link.with_file_name("pacer.pre-app")).unwrap(),
            target
        );
    }

    #[test]
    fn create_refuses_existing_backup_including_dangling_symlink() {
        let dir = TempDir::new();
        let bundled = dir.bundled();
        let link = dir.link();
        let backup = link.with_file_name("pacer.pre-app");
        fs::write(&link, "original").unwrap();
        fs::write(&backup, "older").unwrap();
        assert!(create(&dir.0, &bundled, true).is_err());
        assert_eq!(fs::read_to_string(&backup).unwrap(), "older");
        fs::remove_file(&backup).unwrap();
        symlink("missing", &backup).unwrap();
        assert!(create(&dir.0, &bundled, true).is_err());
        assert_eq!(fs::read_link(&backup).unwrap(), PathBuf::from("missing"));
        assert_eq!(fs::read_to_string(&link).unwrap(), "original");
    }

    #[test]
    fn remembered_requires_the_exact_path_and_version() {
        let dir = TempDir::new();
        let config = dir.0.join("config");
        let choice = KeepMine {
            path: dir.0.join("cli").to_string_lossy().into_owned(),
            version: "0.2.3".into(),
        };
        assert!(!remembered(&config, &choice.path, &choice.version));
        remember(&config, &choice).unwrap();
        assert!(remembered(&config, &choice.path, &choice.version));
        assert!(!remembered(&config, "another-cli", &choice.version));
        assert!(!remembered(&config, &choice.path, "0.2.4"));
    }

    #[test]
    fn remembered_ignores_malformed_or_incomplete_json() {
        let dir = TempDir::new();
        for text in ["broken", "{}", r#"{"path":"cli"}"#] {
            fs::write(dir.0.join("cli-choice.json"), text).unwrap();
            assert!(!remembered(&dir.0, "cli", "0.2.3"));
        }
    }

    #[test]
    fn remember_writes_private_state_and_replaces_atomically() {
        let dir = TempDir::new();
        let config = dir.0.join("config");
        let choice = KeepMine {
            path: "cli".into(),
            version: "0.2.3".into(),
        };
        remember(&config, &choice).unwrap();
        let file = config.join("cli-choice.json");
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let old = config.join("old-choice");
        fs::hard_link(&file, &old).unwrap();
        let changed = KeepMine {
            path: "other-cli".into(),
            version: "0.2.4".into(),
        };
        remember(&config, &changed).unwrap();
        assert!(remembered(&config, &changed.path, &changed.version));
        let previous: KeepMine = serde_json::from_slice(&fs::read(&old).unwrap()).unwrap();
        assert_eq!(previous.path, "cli");
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(&config).unwrap().count(), 2);
    }

    #[test]
    fn remember_cleans_up_after_failed_replacement() {
        let dir = TempDir::new();
        fs::create_dir(dir.0.join("cli-choice.json")).unwrap();
        let choice = KeepMine {
            path: "cli".into(),
            version: "0.2.3".into(),
        };
        assert!(remember(&dir.0, &choice).is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}
