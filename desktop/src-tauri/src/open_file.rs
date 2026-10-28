//! Desktop hand-off of a service-validated session file to the user's editor or
//! file manager (ADR 0011). The page supplies only a session reference; the path
//! comes from the service's bounded resolution and is re-checked here.
use serde_json::{json, Value};
use std::ffi::{CString, OsString};
use std::fs::File;
use std::io::Read;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_EDITOR_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_EDITOR_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Open,
    Reveal,
}
impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "reveal" => Some(Self::Reveal),
            _ => None,
        }
    }
}

/// A `session.file.resolve` result that passed structural validation.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub root: PathBuf,
    pub components: Vec<String>,
    pub absolute: PathBuf,
    pub dev: u64,
    pub ino: u64,
    pub line: u64,
    pub column: u64,
}

fn plain(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_ARG_BYTES
        && !text.bytes().any(|b| b == 0 || b < 0x20 || b == 0x7f)
}

fn position(value: &Value) -> Result<u64, String> {
    match value {
        Value::Null => Ok(1),
        value => value
            .as_u64()
            .filter(|n| (1..=(u32::MAX as u64)).contains(n))
            .ok_or_else(|| "Invalid file location".into()),
    }
}

/// Accept only an absolute root, a relative path of plain components, and an
/// `absolute` that is exactly their join.
pub fn parse_resolution(value: &Value) -> Result<Resolved, String> {
    let invalid = || "Invalid file resolution".to_string();
    let root = value["root"]
        .as_str()
        .filter(|s| plain(s))
        .ok_or_else(invalid)?;
    let path = value["path"]
        .as_str()
        .filter(|s| plain(s))
        .ok_or_else(invalid)?;
    let absolute = value["absolute"]
        .as_str()
        .filter(|s| plain(s))
        .ok_or_else(invalid)?;
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err(invalid());
    }
    let components: Vec<String> = path.split('/').map(str::to_owned).collect();
    if components
        .iter()
        .any(|c| c.is_empty() || c == "." || c == "..")
    {
        return Err(invalid());
    }
    let joined = components.iter().fold(root.clone(), |acc, c| acc.join(c));
    if joined != Path::new(absolute) {
        return Err(invalid());
    }
    Ok(Resolved {
        root,
        components,
        absolute: joined,
        dev: value["dev"].as_u64().ok_or_else(invalid)?,
        ino: value["ino"].as_u64().ok_or_else(invalid)?,
        line: position(&value["line"])?,
        column: position(&value["column"])?,
    })
}

fn open_fd(dir: Option<&OwnedFd>, name: &Path, flags: libc::c_int) -> Result<OwnedFd, String> {
    use std::os::fd::AsRawFd;
    let name = CString::new(name.as_os_str().as_bytes()).map_err(|_| "Invalid path")?;
    let flags = flags | libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: name is NUL-terminated; a returned descriptor is owned exactly once.
    let fd = unsafe {
        match dir {
            Some(dir) => libc::openat(dir.as_raw_fd(), name.as_ptr(), flags),
            None => libc::open(name.as_ptr(), flags),
        }
    };
    if fd < 0 {
        return Err("File unavailable or symbolic link refused".into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Re-walk from the root without following symlinks and require the resolved
/// regular file.
pub fn verify(resolved: &Resolved) -> Result<(), String> {
    let mut dir = open_fd(None, &resolved.root, libc::O_DIRECTORY)?;
    for (index, name) in resolved.components.iter().enumerate() {
        let last = index + 1 == resolved.components.len();
        let flags = if last {
            libc::O_NONBLOCK
        } else {
            libc::O_DIRECTORY
        };
        let fd = open_fd(Some(&dir), Path::new(name), flags)?;
        if last {
            let info = File::from(fd).metadata().map_err(|_| "File unavailable")?;
            if !info.is_file() || info.dev() != resolved.dev || info.ino() != resolved.ino {
                return Err("File changed since it was checked".into());
            }
            return Ok(());
        }
        dir = fd;
    }
    Err("File unavailable".into())
}

fn private_to_user(info: &std::fs::Metadata) -> bool {
    // SAFETY: getuid has no preconditions.
    info.uid() == unsafe { libc::getuid() } && info.mode() & 0o022 == 0
}

/// The user's editor from `<home>/desktop/editor.json`, which no API operation
/// writes. The file and both directories above it must be the user's and not
/// writable by others; the file is reached without following symlinks.
pub fn load_editor(home: &Path) -> Result<Option<Vec<String>>, String> {
    let untrusted =
        || "Editor settings must be owned by you and not writable by others".to_string();
    let Ok(home_fd) = open_fd(None, home, libc::O_DIRECTORY).or_else(|_| {
        // PACER_HOME itself may be a link the user made; its target is checked below.
        let real = std::fs::canonicalize(home).map_err(|_| String::new())?;
        open_fd(None, &real, libc::O_DIRECTORY)
    }) else {
        return Ok(None);
    };
    let home_info = File::from(home_fd.try_clone().map_err(|_| untrusted())?)
        .metadata()
        .map_err(|_| untrusted())?;
    let desktop = match open_fd(Some(&home_fd), Path::new("desktop"), libc::O_DIRECTORY) {
        Ok(fd) => fd,
        Err(_) if home.join("desktop").symlink_metadata().is_err() => return Ok(None),
        Err(_) => return Err(untrusted()),
    };
    let desktop_info = File::from(desktop.try_clone().map_err(|_| untrusted())?)
        .metadata()
        .map_err(|_| untrusted())?;
    let path = home.join("desktop").join("editor.json");
    let fd = match open_fd(Some(&desktop), Path::new("editor.json"), libc::O_NONBLOCK) {
        Ok(fd) => fd,
        Err(_) if path.symlink_metadata().is_err() => return Ok(None),
        Err(_) => return Err("Editor settings must be a regular file, not a link".into()),
    };
    let file = File::from(fd);
    let info = file
        .metadata()
        .map_err(|_| "Editor settings are unreadable")?;
    if !private_to_user(&home_info)
        || !private_to_user(&desktop_info)
        || !info.is_file()
        || !private_to_user(&info)
    {
        return Err(untrusted());
    }
    let mut text = String::new();
    file.take(MAX_EDITOR_CONFIG_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Editor settings are unreadable")?;
    if text.len() as u64 > MAX_EDITOR_CONFIG_BYTES {
        return Err("Editor settings are too large".into());
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|_| "Editor settings are not valid JSON")?;
    parse_editor(&value).map(Some)
}

pub fn parse_editor(value: &Value) -> Result<Vec<String>, String> {
    let invalid = || {
        "Editor command must be an array of strings starting with an absolute program".to_string()
    };
    let command = value["command"].as_array().ok_or_else(invalid)?;
    if command.is_empty() || command.len() > MAX_EDITOR_ARGS {
        return Err(invalid());
    }
    let command: Vec<String> = command
        .iter()
        .map(|arg| arg.as_str().filter(|s| plain(s)).map(str::to_owned))
        .collect::<Option<_>>()
        .ok_or_else(invalid)?;
    if !Path::new(&command[0]).is_absolute() || command[0].contains('{') {
        return Err(invalid());
    }
    Ok(command)
}

/// Substitute placeholders inside each element; an element never splits.
pub fn editor_argv(template: &[String], resolved: &Resolved) -> Vec<OsString> {
    let path = resolved.absolute.as_os_str().as_bytes();
    let (line, column) = (resolved.line.to_string(), resolved.column.to_string());
    let mut argv = vec![OsString::from(&template[0])];
    for arg in &template[1..] {
        let mut out = Vec::with_capacity(arg.len());
        let mut rest = arg.as_str();
        while let Some(start) = rest.find('{') {
            out.extend_from_slice(&rest.as_bytes()[..start]);
            let tail = &rest[start..];
            let (value, len): (&[u8], usize) = if tail.starts_with("{path}") {
                (path, 6)
            } else if tail.starts_with("{line}") {
                (line.as_bytes(), 6)
            } else if tail.starts_with("{column}") {
                (column.as_bytes(), 8)
            } else {
                (b"{", 1)
            };
            out.extend_from_slice(value);
            rest = &tail[len..];
        }
        out.extend_from_slice(rest.as_bytes());
        argv.push(std::ffi::OsStr::from_bytes(&out).to_os_string());
    }
    argv
}

/// The argument vector for an action. Only `Open` uses a configured editor.
pub fn argv(
    action: Action,
    resolved: &Resolved,
    editor: Option<&[String]>,
    os: &str,
) -> Result<Vec<OsString>, String> {
    let path = resolved.absolute.as_os_str().to_os_string();
    match (action, editor, os) {
        (Action::Open, Some(template), _) => Ok(editor_argv(template, resolved)),
        // LaunchServices' text editor, never the type's handler, so nothing is executed.
        (Action::Open, None, "macos") => Ok(vec!["/usr/bin/open".into(), "-t".into(), path]),
        (Action::Reveal, _, "macos") => Ok(vec!["/usr/bin/open".into(), "-R".into(), path]),
        // xdg-open picks a handler by content type and may run it; Linux needs a configured editor.
        (Action::Open, None, "linux") => {
            Err("Configure an editor to open files on this platform".into())
        }
        (Action::Reveal, _, "linux") => {
            let parent = resolved.absolute.parent().ok_or("File unavailable")?;
            Ok(vec![
                "/usr/bin/xdg-open".into(),
                parent.as_os_str().to_os_string(),
            ])
        }
        _ => Err("Opening files is not supported on this platform".into()),
    }
}

/// What the shell can do, for the page's capability check.
pub fn supported(os: &str, editor_configured: bool) -> Value {
    match os {
        "macos" => json!({"open": true, "reveal": true, "revealLabel": "Reveal in Finder"}),
        "linux" => {
            json!({"open": editor_configured, "reveal": true, "revealLabel": "Show in folder"})
        }
        _ => json!({"open": false, "reveal": false, "revealLabel": null}),
    }
}

/// A launch without a shell, with null stdio and no Pacer environment.
pub fn command(argv: &[OsString]) -> Result<Command, String> {
    let (program, args) = argv.split_first().ok_or("Missing program")?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        if key.as_bytes().starts_with(b"PACER") {
            command.env_remove(key);
        }
    }
    Ok(command)
}

/// Launch and reap the hand-off.
pub fn spawn(argv: &[OsString]) -> Result<(), String> {
    let mut child = command(argv)?
        .spawn()
        .map_err(|_| "Unable to start the editor")?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn resolution(root: &Path, path: &str) -> Value {
        let info = std::fs::metadata(root.join(path)).unwrap();
        json!({"root": root, "path": path, "absolute": root.join(path), "dev": info.dev(), "ino": info.ino(), "line": 12})
    }

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        (dir, root)
    }

    #[test]
    fn open_in_editor_accepts_a_matching_resolution_and_verifies_identity() {
        let (_dir, root) = workspace();
        let resolved = parse_resolution(&resolution(&root, "src/main.rs")).unwrap();
        assert_eq!(resolved.absolute, root.join("src/main.rs"));
        assert_eq!((resolved.line, resolved.column), (12, 1));
        verify(&resolved).unwrap();
    }

    #[test]
    fn open_in_editor_rejects_malformed_resolutions() {
        let (_dir, root) = workspace();
        let good = resolution(&root, "src/main.rs");
        for (key, value) in [
            ("root", json!("relative/root")),
            ("path", json!("../src/main.rs")),
            ("path", json!("src//main.rs")),
            ("path", json!("src/./main.rs")),
            ("absolute", json!("/etc/hosts")),
            (
                "absolute",
                json!(format!("{}/src/main.rs\n", root.display())),
            ),
            ("dev", json!(null)),
            ("line", json!(0)),
            ("column", json!("3")),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert!(parse_resolution(&bad).is_err(), "{key} accepted");
        }
    }

    #[test]
    fn open_in_editor_verification_refuses_swaps_symlinks_and_directories() {
        let (_dir, root) = workspace();
        let resolved = parse_resolution(&resolution(&root, "src/main.rs")).unwrap();
        std::fs::remove_file(root.join("src/main.rs")).unwrap();
        std::fs::write(root.join("other"), "x").unwrap();
        std::fs::write(root.join("src/main.rs"), "replaced").unwrap();
        assert!(
            verify(&resolved).is_err(),
            "a replaced file kept its identity"
        );

        let outside = tempfile::NamedTempFile::new().unwrap();
        let info = outside.as_file().metadata().unwrap();
        symlink(outside.path(), root.join("link.txt")).unwrap();
        let mut linked = parse_resolution(&resolution(&root, "other")).unwrap();
        linked.components = vec!["link.txt".into()];
        (linked.dev, linked.ino) = (info.dev(), info.ino());
        assert!(verify(&linked).is_err(), "a symlinked file was followed");

        symlink(root.join("src"), root.join("dir-link")).unwrap();
        let mut through = parse_resolution(&resolution(&root, "src/main.rs")).unwrap();
        through.components = vec!["dir-link".into(), "main.rs".into()];
        assert!(
            verify(&through).is_err(),
            "a symlinked directory was followed"
        );

        let mut directory = parse_resolution(&resolution(&root, "src/main.rs")).unwrap();
        directory.components = vec!["src".into()];
        let src = std::fs::metadata(root.join("src")).unwrap();
        (directory.dev, directory.ino) = (src.dev(), src.ino());
        assert!(verify(&directory).is_err(), "a directory was accepted");
    }

    #[test]
    fn open_in_editor_substitutes_placeholders_inside_single_elements() {
        let (_dir, root) = workspace();
        std::fs::write(root.join("a b; rm -rf ~"), "x").unwrap();
        let mut resolved = parse_resolution(&resolution(&root, "a b; rm -rf ~")).unwrap();
        resolved.column = 4;
        let template: Vec<String> = [
            "/usr/local/bin/code",
            "--goto",
            "{path}:{line}:{column}",
            "{unknown}",
            "{",
        ]
        .map(String::from)
        .into();
        let argv = editor_argv(&template, &resolved);
        assert_eq!(argv.len(), 5);
        assert_eq!(
            argv[2],
            OsString::from(format!("{}:12:4", root.join("a b; rm -rf ~").display()))
        );
        assert_eq!(argv[3], OsString::from("{unknown}"));
        assert_eq!(argv[4], OsString::from("{"));
    }

    #[test]
    fn open_in_editor_never_expands_placeholders_inside_the_path() {
        let (_dir, root) = workspace();
        std::fs::write(root.join("{line}{column}"), "x").unwrap();
        let resolved = parse_resolution(&resolution(&root, "{line}{column}")).unwrap();
        let template: Vec<String> = ["/usr/bin/vim", "{path}"].map(String::from).into();
        assert_eq!(
            editor_argv(&template, &resolved)[1],
            OsString::from(root.join("{line}{column}"))
        );
    }

    #[test]
    fn open_in_editor_settings_require_an_absolute_program_and_a_private_file() {
        assert!(parse_editor(&json!({"command": ["code", "{path}"]})).is_err());
        assert!(parse_editor(&json!({"command": ["/bin/{path}"]})).is_err());
        assert!(parse_editor(&json!({"command": []})).is_err());
        assert!(parse_editor(&json!({"command": ["/usr/bin/vim", 3]})).is_err());
        assert!(parse_editor(&json!({"command": ["/usr/bin/vim", "a\nb"]})).is_err());
        assert_eq!(
            parse_editor(&json!({"command": ["/usr/bin/vim", "+{line}", "{path}"]}))
                .unwrap()
                .len(),
            3
        );

        let home = tempfile::tempdir().unwrap();
        assert_eq!(load_editor(home.path()).unwrap(), None);
        assert_eq!(load_editor(&home.path().join("missing")).unwrap(), None);
        let desktop = home.path().join("desktop");
        std::fs::create_dir(&desktop).unwrap();
        assert_eq!(load_editor(home.path()).unwrap(), None);
        let config = desktop.join("editor.json");
        std::fs::write(&config, r#"{"command":["/usr/bin/vim","{path}"]}"#).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            load_editor(home.path()).unwrap().unwrap()[0],
            "/usr/bin/vim"
        );

        std::fs::set_permissions(&desktop, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            load_editor(home.path()).is_err(),
            "a world-writable settings directory was trusted"
        );
        std::fs::set_permissions(&desktop, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(
            load_editor(home.path()).is_err(),
            "a world-writable editor file was trusted"
        );

        std::fs::remove_file(&config).unwrap();
        let target = home.path().join("elsewhere.json");
        std::fs::write(&target, r#"{"command":["/usr/bin/vim"]}"#).unwrap();
        symlink(&target, &config).unwrap();
        assert!(
            load_editor(home.path()).is_err(),
            "a linked editor file was trusted"
        );

        std::fs::remove_file(&config).unwrap();
        std::fs::create_dir(&config).unwrap();
        assert!(load_editor(home.path()).is_err(), "a directory was trusted");
        std::fs::remove_dir(&config).unwrap();
        let fifo = CString::new(config.as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo is a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(load_editor(home.path()).is_err(), "a FIFO was trusted");
        std::fs::remove_file(&config).unwrap();

        std::fs::write(
            &config,
            format!(
                r#"{{"command":["/usr/bin/vim"],"pad":"{}"}}"#,
                "x".repeat(70_000)
            ),
        )
        .unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            load_editor(home.path()).is_err(),
            "an oversized file was read"
        );
    }

    #[test]
    fn open_in_editor_launch_has_no_pacer_environment_or_stdio() {
        std::env::set_var("PACER_OPEN_FILE_TEST", "secret");
        let command = command(&["/usr/bin/true".into(), "x".into()]).unwrap();
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "PACER_OPEN_FILE_TEST" && value.is_none()));
        assert_eq!(command.get_current_dir(), Some(Path::new("/")));
        assert!(super::command(&[]).is_err());
    }

    #[test]
    fn open_in_editor_default_handlers_never_launch_by_file_type() {
        let (_dir, root) = workspace();
        std::fs::write(root.join("run.command"), "x").unwrap();
        let resolved = parse_resolution(&resolution(&root, "run.command")).unwrap();
        let path = OsString::from(root.join("run.command"));
        assert_eq!(
            argv(Action::Open, &resolved, None, "macos").unwrap(),
            vec!["/usr/bin/open".into(), "-t".into(), path.clone()]
        );
        assert_eq!(
            argv(Action::Reveal, &resolved, None, "macos").unwrap(),
            vec!["/usr/bin/open".into(), "-R".into(), path.clone()]
        );
        let main = parse_resolution(&resolution(&root, "src/main.rs")).unwrap();
        assert!(argv(Action::Open, &main, None, "linux").is_err());
        assert_eq!(
            argv(Action::Reveal, &main, None, "linux").unwrap(),
            vec!["/usr/bin/xdg-open".into(), OsString::from(root.join("src"))]
        );
        assert!(argv(Action::Open, &main, None, "windows").is_err());
        let editor = vec!["/usr/bin/vim".to_string(), "{path}".to_string()];
        assert_eq!(
            argv(Action::Open, &resolved, Some(&editor), "linux").unwrap(),
            vec!["/usr/bin/vim".into(), path]
        );
        assert_eq!(
            argv(Action::Reveal, &main, Some(&editor), "macos").unwrap()[0],
            "/usr/bin/open"
        );
        assert_eq!(supported("windows", true)["open"], false);
        assert_eq!(supported("linux", false)["open"], false);
        assert_eq!(supported("linux", true)["open"], true);
        assert_eq!(supported("macos", false)["revealLabel"], "Reveal in Finder");
        assert_eq!(
            (Action::parse("open"), Action::parse("exec")),
            (Some(Action::Open), None)
        );
    }
}
