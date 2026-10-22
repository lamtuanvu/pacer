#![allow(clippy::unwrap_used)]
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

#[test]
fn version_probe_bounds_time_and_output() {
    let dir = tempfile::tempdir().unwrap();
    let core = dir.path().join("core");
    for script in [
        "#!/bin/sh\nprintf '%0100000d' 0\n",
        "#!/bin/sh\necho 'pacer 1.2.3 extra'\n",
        "#!/bin/sh\nexec sleep 30\n",
    ] {
        fs::write(&core, script).unwrap();
        fs::set_permissions(&core, fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(pacer_cli::self_repair::core_version(&core), None);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}

#[test]
fn insecure_or_credentialed_release_bases_are_rejected_locally() {
    for base in [
        "http://example.invalid",
        "https://user:pass@example.invalid",
        "http://127.0.0.1:1/?query",
        "file:///tmp",
    ] {
        let install = Install::new();
        let output = install.run(&["self-repair", "--base", base], base, false);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("invalid release"));
        assert!(!install.core().exists());
    }
}

struct Feed {
    base: String,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Feed {
    fn new(version: &str, core: &[u8], hash: &str) -> Self {
        Self::altered(version, core, hash, |_| {})
    }
    fn altered(
        version: &str,
        core: &[u8],
        hash: &str,
        alter: impl FnOnce(&mut serde_json::Value),
    ) -> Self {
        let os = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let file = format!("pacer-core-{os}-{arch}");
        let mut manifest = serde_json::json!({"version":version,"assets":[{
            "os":os,"arch":arch,"file":format!("pacer-{os}-{arch}"),
            "sha256":"0".repeat(64),"size":1,
            "companions":[{"name":"pacer-core","file":file,"sha256":hash,"size":core.len()}]
        }]});
        alter(&mut manifest);
        let manifest = manifest.to_string();
        let routes = HashMap::from([
            (format!("/{version}/manifest.json"), manifest.into_bytes()),
            (format!("/{version}/{file}"), core.to_vec()),
        ]);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let halt = stop.clone();
        let count = requests.clone();
        let worker = thread::spawn(move || {
            while !halt.load(Ordering::Relaxed) {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .unwrap();
                    let mut request = String::new();
                    let mut reader = BufReader::new(&stream);
                    if reader.read_line(&mut request).unwrap_or_default() == 0 {
                        continue;
                    }
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or_default() == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    let path = request.split_whitespace().nth(1).unwrap_or_default();
                    count.fetch_add(1, Ordering::Relaxed);
                    let (status, bytes) = routes
                        .get(path)
                        .map(|b| (200, b.as_slice()))
                        .unwrap_or((404, b"missing"));
                    let header = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    );
                    let _ = stream
                        .write_all(header.as_bytes())
                        .and_then(|()| stream.write_all(bytes));
                } else {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });
        Self {
            base,
            stop,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for Feed {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[test]
fn invalid_manifest_identity_and_sizes_never_download_the_core() {
    for case in ["version", "duplicate", "name", "file", "oversize", "zero"] {
        let install = Install::new();
        let script = install.script();
        let feed = Feed::altered(&install.version, &script, &hash(&script), |v| match case {
            "version" => v["version"] = "0.0.1".into(),
            "duplicate" => {
                let asset = v["assets"][0].clone();
                v["assets"].as_array_mut().unwrap().push(asset);
            }
            "name" => v["assets"][0]["companions"][0]["name"] = "unknown".into(),
            "file" => v["assets"][0]["companions"][0]["file"] = "../pacer".into(),
            "oversize" => v["assets"][0]["companions"][0]["size"] = (201 * 1024 * 1024).into(),
            _ => v["assets"][0]["companions"][0]["size"] = 0.into(),
        });
        let output = install.run(&["self-repair"], &feed.base, false);
        assert!(!output.status.success(), "{case}");
        assert!(!install.core().exists());
        assert_eq!(feed.requests.load(Ordering::Relaxed), 1);
    }
}

struct Install {
    dir: tempfile::TempDir,
    exe: PathBuf,
    version: String,
}
impl Install {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("pacer");
        fs::copy(env!("CARGO_BIN_EXE_pacer"), &exe).unwrap();
        let output = Command::new(&exe).arg("--version").output().unwrap();
        let version = String::from_utf8(output.stdout)
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_owned();
        Self { dir, exe, version }
    }
    fn run(&self, args: &[&str], base: &str, disabled: bool) -> Output {
        Command::new(&self.exe)
            .args(args)
            .env_remove("PACER_CORE_ARGV")
            .env_remove("PACER_BIN")
            .env("PACER_HOME", self.dir.path().join("state"))
            .env("PACER_RELEASE_BASE", base)
            .env("PACER_NO_SELF_REPAIR", if disabled { "1" } else { "0" })
            .output()
            .unwrap()
    }
    fn core(&self) -> PathBuf {
        self.dir.path().join("pacer-core")
    }
    fn script(&self) -> Vec<u8> {
        format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'pacer {}'; else echo repaired-route; fi\n", self.version).into_bytes()
    }
}

// openssl is only a test fixture helper; production hashing is in Rust.
fn hash(bytes: &[u8]) -> String {
    let mut child = Command::new("openssl")
        .args(["dgst", "-sha256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout)
        .unwrap()
        .split_whitespace()
        .last()
        .unwrap()
        .into()
}

#[test]
fn automatic_repair_downloads_own_version_and_executes_core() {
    let install = Install::new();
    let script = install.script();
    let feed = Feed::new(&install.version, &script, &hash(&script));
    let output = install.run(&["route"], &feed.base, false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "repaired-route\n");
    assert_eq!(fs::read(install.core()).unwrap(), script);
    assert_eq!(
        fs::metadata(install.core()).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let again = install.run(&["route"], &feed.base, false);
    assert!(again.status.success());
    assert_eq!(feed.requests.load(Ordering::Relaxed), 2);
    let cache = install.dir.path().join("state/run/core-version.json");
    assert_eq!(
        fs::metadata(cache).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // Replacing the file must invalidate the successful hourly cache immediately.
    fs::write(install.core(), "#!/bin/sh\necho 'pacer 0.0.1'\n").unwrap();
    let replaced = install.run(&["route"], &feed.base, false);
    assert!(replaced.status.success());
    assert_eq!(fs::read(install.core()).unwrap(), script);
    assert_eq!(feed.requests.load(Ordering::Relaxed), 4);
}

#[test]
fn explicit_repair_replaces_wrong_version_and_is_idempotent() {
    let install = Install::new();
    fs::write(install.core(), "#!/bin/sh\necho 'pacer 0.0.1'\n").unwrap();
    fs::set_permissions(install.core(), fs::Permissions::from_mode(0o755)).unwrap();
    let script = install.script();
    let feed = Feed::new(&install.version, &script, &hash(&script));
    for _ in 0..2 {
        let output = install.run(&["self-repair", "--base", &feed.base], &feed.base, false);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(fs::read(install.core()).unwrap(), script);
    assert_eq!(feed.requests.load(Ordering::Relaxed), 2);
}

#[test]
fn checksum_and_smoke_failures_preserve_the_previous_core() {
    for bad_hash in [true, false] {
        let install = Install::new();
        let old = b"#!/bin/sh\necho 'pacer 0.0.1'\n";
        fs::write(install.core(), old).unwrap();
        fs::set_permissions(install.core(), fs::Permissions::from_mode(0o755)).unwrap();
        let script = if bad_hash {
            install.script()
        } else {
            b"#!/bin/sh\necho 'pacer 0.0.2'\n".to_vec()
        };
        let checksum = if bad_hash {
            "0".repeat(64)
        } else {
            hash(&script)
        };
        let feed = Feed::new(&install.version, &script, &checksum);
        let output = install.run(&["self-repair"], &feed.base, false);
        assert!(!output.status.success());
        assert_eq!(fs::read(install.core()).unwrap(), old);
        assert!(!install.dir.path().join("pacer-core.new").exists());
    }
}

#[test]
fn disabled_and_readonly_automatic_repair_do_not_contact_feed() {
    for readonly in [false, true] {
        let install = Install::new();
        let script = install.script();
        let feed = Feed::new(&install.version, &script, &hash(&script));
        if readonly {
            fs::set_permissions(install.dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        }
        let output = install.run(&["route"], &feed.base, !readonly);
        if readonly {
            fs::set_permissions(install.dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("pacer-core is missing"));
        assert_eq!(feed.requests.load(Ordering::Relaxed), 0);
    }
}
