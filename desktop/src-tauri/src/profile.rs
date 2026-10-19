use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const BLOCK: &str =
    "# >>> pacer >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< pacer <<<\n";

pub fn rc_file(home: &Path, shell: &str) -> Option<PathBuf> {
    match Path::new(shell).file_name()?.to_str()? {
        "zsh" => Some(home.join(".zshrc")),
        "bash" => Some(home.join(".bashrc")),
        _ => None,
    }
}

pub fn on_path(login_path: &str, home: &Path) -> bool {
    let bin = home.join(".local/bin");
    login_path
        .split(':')
        .any(|entry| Some(entry.trim_end_matches('/')) == bin.to_str())
}

pub fn add_block(text: &str) -> Option<String> {
    if remove_block(text).is_some() {
        return None;
    }
    let separator = if text.is_empty() || text.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    Some(format!("{text}{separator}{BLOCK}"))
}

pub fn remove_block(text: &str) -> Option<String> {
    let mut cleaned = String::new();
    let mut start = None;
    let mut offset = 0;
    let mut kept_until = 0;
    let mut removed = false;
    for line in text.split_inclusive('\n') {
        if start.is_none() && matches!(line, "# >>> pacer >>>\n" | "# >>> pacer >>>\r\n") {
            start = Some(offset);
        } else if let Some(begin) = start {
            if matches!(
                line,
                "# <<< pacer <<<\n" | "# <<< pacer <<<\r\n" | "# <<< pacer <<<"
            ) {
                cleaned.push_str(&text[kept_until..begin]);
                kept_until = offset + line.len();
                start = None;
                removed = true;
            }
        }
        offset += line.len();
    }
    if !removed {
        return None;
    }
    cleaned.push_str(&text[kept_until..]);
    Some(cleaned)
}

#[derive(Debug, PartialEq, Eq)]
pub enum EditOutcome {
    Added,
    AlreadyPresent,
    Skipped(&'static str),
}

pub fn apply(rc: &Path) -> EditOutcome {
    let metadata = match fs::symlink_metadata(rc) {
        Ok(metadata) if metadata.is_symlink() => return EditOutcome::Skipped("symlink"),
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => return EditOutcome::Skipped("not writable"),
    };
    let (text, mode) = if let Some(metadata) = metadata {
        if !metadata.is_file()
            || metadata.permissions().readonly()
            || OpenOptions::new().write(true).open(rc).is_err()
        {
            return EditOutcome::Skipped("not writable");
        }
        let text = match fs::read_to_string(rc) {
            Ok(text) => text,
            Err(_) => return EditOutcome::Skipped("not writable"),
        };
        (text, metadata.permissions().mode())
    } else {
        (String::new(), 0o644)
    };
    let Some(updated) = add_block(&text) else {
        return EditOutcome::AlreadyPresent;
    };
    match atomic_write(rc, updated.as_bytes(), mode) {
        Ok(()) => EditOutcome::Added,
        Err(_) => EditOutcome::Skipped("not writable"),
    }
}

fn atomic_write(rc: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = rc.with_file_name(format!(
        ".pacer-profile-{}-{}-{}.tmp",
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
        .open(&temp)?;
    let result = (|| {
        file.write_all(contents)?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        fs::rename(&temp, rc)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "pacer-profile-test-{}-{}-{}",
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
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn rc_file_selects_only_supported_shell_basenames() {
        let home = TempDir::new();
        for (shell, expected) in [
            ("zsh", Some(".zshrc")),
            ("/bin/zsh", Some(".zshrc")),
            ("bash", Some(".bashrc")),
            ("/bin/bash", Some(".bashrc")),
            ("fish", None),
            ("/bin/fish", None),
            ("", None),
        ] {
            assert_eq!(rc_file(&home.0, shell), expected.map(|rc| home.0.join(rc)));
        }
    }

    #[test]
    fn on_path_matches_whole_entries_ignoring_trailing_slashes() {
        let home = TempDir::new();
        let bin = home.0.join(".local/bin");
        for suffix in ["", "/", "///"] {
            assert!(on_path(
                &format!("/usr/bin:{}{suffix}:/bin", bin.display()),
                &home.0
            ));
        }
        for path in [
            String::new(),
            "/usr/bin:/bin".into(),
            format!("{}-other", bin.display()),
        ] {
            assert!(!on_path(&path, &home.0));
        }
    }

    #[test]
    fn add_block_appends_exact_shell_lines_and_preserves_existing_bytes() {
        let expected = "# >>> pacer >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< pacer <<<\n";
        assert_eq!(add_block(""), Some(expected.into()));
        assert_eq!(add_block("# custom"), Some(format!("# custom\n{expected}")));
        assert_eq!(
            add_block("# custom\n"),
            Some(format!("# custom\n{expected}"))
        );
    }

    #[test]
    fn add_block_does_not_duplicate_a_complete_block() {
        assert_eq!(add_block(BLOCK), None);
        assert_eq!(
            add_block("# >>> pacer >>>\r\ncustom\r\n# <<< pacer <<<"),
            None
        );
    }

    #[test]
    fn add_block_does_not_mistake_an_incomplete_block_for_a_complete_one() {
        let text = "# >>> pacer >>>\nunfinished\n";
        assert_eq!(add_block(text), Some(format!("{text}{BLOCK}")));
    }

    #[test]
    fn remove_block_preserves_bytes_around_middle_and_eof_blocks() {
        assert_eq!(
            remove_block(&format!("before\n{BLOCK}after\n")),
            Some("before\nafter\n".into())
        );
        assert_eq!(
            remove_block("before\n# >>> pacer >>>\ncustom\n# <<< pacer <<<"),
            Some("before\n".into())
        );
        assert_eq!(
            remove_block(&format!("before\n{BLOCK}")),
            Some("before\n".into())
        );
    }

    #[test]
    fn remove_block_removes_each_complete_block_with_crlf_or_lf() {
        let text = format!("α\r\n# >>> pacer >>>\r\ncustom\r\n# <<< pacer <<<\r\n\r\n{BLOCK}ω");
        assert_eq!(remove_block(&text), Some("α\r\n\r\nω".into()));
    }

    #[test]
    fn remove_block_leaves_partial_and_inline_markers_untouched() {
        for text in [
            "",
            "# >>> pacer >>>\nunfinished\n",
            "prefix # >>> pacer >>>\ncustom\n# <<< pacer <<<\n",
            "# >>> pacer >>>\ncustom\n# <<< pacer <<< suffix\n",
        ] {
            assert_eq!(remove_block(text), None);
        }
    }

    #[test]
    fn apply_skips_symlinks_without_changing_the_target() {
        let dir = TempDir::new();
        let target = dir.0.join("target");
        let rc = dir.0.join(".zshrc");
        fs::write(&target, "original").unwrap();
        symlink(&target, &rc).unwrap();
        assert_eq!(apply(&rc), EditOutcome::Skipped("symlink"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert!(fs::symlink_metadata(&rc).unwrap().is_symlink());
    }

    #[test]
    fn apply_skips_read_only_files() {
        let dir = TempDir::new();
        let rc = dir.0.join(".zshrc");
        fs::write(&rc, "original").unwrap();
        fs::set_permissions(&rc, fs::Permissions::from_mode(0o444)).unwrap();
        assert_eq!(apply(&rc), EditOutcome::Skipped("not writable"));
        assert_eq!(fs::read_to_string(&rc).unwrap(), "original");
    }

    #[test]
    fn apply_creates_missing_file_with_mode_0644() {
        let dir = TempDir::new();
        let rc = dir.0.join(".zshrc");
        assert_eq!(apply(&rc), EditOutcome::Added);
        assert_eq!(fs::read_to_string(&rc).unwrap(), BLOCK);
        assert_eq!(
            fs::metadata(&rc).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn apply_keeps_private_mode_and_is_idempotent() {
        let dir = TempDir::new();
        let rc = dir.0.join(".bashrc");
        fs::write(&rc, "# custom").unwrap();
        fs::set_permissions(&rc, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(apply(&rc), EditOutcome::Added);
        assert_eq!(
            fs::read_to_string(&rc).unwrap(),
            format!("# custom\n{BLOCK}")
        );
        assert_eq!(
            fs::metadata(&rc).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(apply(&rc), EditOutcome::AlreadyPresent);
        assert_eq!(
            fs::read_to_string(&rc).unwrap(),
            format!("# custom\n{BLOCK}")
        );
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn apply_reports_unwritable_paths_without_creating_parents() {
        let dir = TempDir::new();
        assert_eq!(
            apply(&dir.0.join("missing/.zshrc")),
            EditOutcome::Skipped("not writable")
        );
        assert_eq!(apply(&dir.0), EditOutcome::Skipped("not writable"));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }
}
