#![allow(clippy::unwrap_used)]
use std::{fs, os::unix::fs::PermissionsExt, process::Command};
fn pacer() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_pacer"));
    c.env_remove("PACER_BIN").env_remove("PACER_CORE_ARGV");
    c
}
/// The version the front door was built with: the build override, else package.json.
fn expected_version() -> String {
    if let Some(version) = option_env!("PACER_BUILD_VERSION") {
        return version.into();
    }
    let package = concat!(env!("CARGO_MANIFEST_DIR"), "/../../package.json");
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(package).unwrap()).unwrap();
    value["version"].as_str().unwrap().into()
}
#[test]
fn version_is_native() {
    for arg in ["--version", "version"] {
        let o = pacer()
            .env("PACER_CORE_ARGV", "invalid")
            .arg(arg)
            .output()
            .unwrap();
        assert!(o.status.success());
        assert_eq!(
            String::from_utf8(o.stdout).unwrap(),
            format!("pacer {}\n", expected_version())
        );
    }
}
#[test]
fn commands_exec_core_with_arguments_and_environment() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("core.sh");
    fs::write(
        &fake,
        "#!/bin/sh\nprintf '%s|' \"$@\"; printf 'BIN=%s' \"$PACER_BIN\"\nexit 7\n",
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    for bin in [None, Some("/x/pacer")] {
        let mut cmd = pacer();
        cmd.env(
            "PACER_CORE_ARGV",
            serde_json::to_string(&[fake.to_str().unwrap(), "prefix"]).unwrap(),
        );
        if let Some(bin) = bin {
            cmd.env("PACER_BIN", bin);
        }
        let o = cmd
            .args(["route", "--json", "a b", "$(literal)"])
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(7));
        let expected = bin.map(String::from).unwrap_or_else(|| {
            fs::canonicalize(env!("CARGO_BIN_EXE_pacer"))
                .unwrap()
                .to_string_lossy()
                .into_owned()
        });
        assert_eq!(
            String::from_utf8(o.stdout).unwrap(),
            format!("prefix|route|--json|a b|$(literal)|BIN={expected}")
        );
    }
}
#[test]
fn bad_core_argv_is_usage_error() {
    for value in ["not json", "[]", "[1]", "null", "\"core\""] {
        let o = pacer()
            .env("PACER_CORE_ARGV", value)
            .arg("route")
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(2), "{value}");
    }
}
#[test]
fn missing_core_explains_itself() {
    let o = pacer().arg("route").output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(
        String::from_utf8(o.stderr)
            .unwrap()
            .contains("pacer-core is missing")
    );
}
#[test]
fn exec_failure_explains_itself() {
    let o = pacer()
        .env("PACER_CORE_ARGV", "[\"/nonexistent/pacer-core\"]")
        .arg("route")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(
        String::from_utf8(o.stderr)
            .unwrap()
            .contains("could not start pacer-core")
    );
}

fn line_command(home: &std::path::Path, port: u16) -> Command {
    let mut c = pacer();
    c.env("PACER_HOME", home)
        .env("PACER_PORT", port.to_string())
        .env("TZ", "Asia/Ho_Chi_Minh")
        .env_remove("NO_COLOR")
        .env_remove("PACER")
        .args(["status", "--line", "--width", "120", "--no-color"]);
    c
}
fn fixture() -> (serde_json::Value, String, serde_json::Value) {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../cli/tests/golden/status-line.json")).unwrap();
    let case = cases
        .iter()
        .find(|c| c["width"] == 120 && c["color"] == false)
        .unwrap();
    (
        case["input"].clone(),
        format!("{}\n", case["out"].as_str().unwrap()),
        case["fields"].clone(),
    )
}
fn server(body: String, status: &str) -> (u16, std::thread::JoinHandle<String>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let status = status.to_string();
    let handle = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(e) => panic!("HTTP test server: {e}"),
            }
        };
        // macOS: an accepted socket inherits O_NONBLOCK from the listener.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).unwrap(), 1);
            request.push(byte[0]);
        }
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        String::from_utf8(request).unwrap()
    });
    (port, handle)
}
fn write_link(home: &std::path::Path, snapshot: &serde_json::Value, age: f64) {
    let mut snapshot = snapshot.clone();
    snapshot["at"] = serde_json::json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            - age
    );
    fs::create_dir_all(home.join("link")).unwrap();
    fs::write(
        home.join("link/latest.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
}
#[test]
fn native_line_reads_authenticated_http_snapshot() {
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("token"), "  test-token\n").unwrap();
    let (snapshot, expected, fields) = fixture();
    let (port, thread) = server(
        serde_json::json!({"snapshot":snapshot}).to_string(),
        "200 OK",
    );
    let o = line_command(home.path(), port)
        .env("PACER_CORE_ARGV", "invalid")
        .output()
        .unwrap();
    assert!(o.status.success());
    assert_eq!(String::from_utf8(o.stdout).unwrap(), expected);
    let request = thread.join().unwrap();
    assert!(
        request.starts_with("GET /v2/snapshot HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token\r\n")
    );
    let (port, thread) = server(
        serde_json::json!({"snapshot":snapshot}).to_string(),
        "200 OK",
    );
    let o = line_command(home.path(), port)
        .arg("--json")
        .output()
        .unwrap();
    assert!(o.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&o.stdout).unwrap(),
        fields
    );
    thread.join().unwrap();
}
#[test]
fn native_line_uses_fresh_link_when_service_fails() {
    let home = tempfile::tempdir().unwrap();
    let (snapshot, expected, _) = fixture();
    write_link(home.path(), &snapshot, 0.0);
    let o = line_command(home.path(), 0).output().unwrap();
    assert!(o.status.success());
    assert_eq!(String::from_utf8(o.stdout).unwrap(), expected);
}
#[test]
fn native_line_is_offline_with_missing_stale_or_torn_link() {
    let home = tempfile::tempdir().unwrap();
    let (snapshot, _, _) = fixture();
    for state in ["missing", "stale", "torn"] {
        match state {
            "stale" => write_link(home.path(), &snapshot, 121.0),
            "torn" => fs::write(home.path().join("link/latest.json"), "{").unwrap(),
            _ => {}
        }
        let o = line_command(home.path(), 0).output().unwrap();
        assert_eq!(o.status.code(), Some(0));
        assert_eq!(
            o.stdout,
            "▬┃ pacer not running · pacer serve\n".as_bytes(),
            "{state}"
        );
    }
}
#[test]
fn unusable_http_responses_fall_back_to_link() {
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("token"), "test-token").unwrap();
    let (snapshot, expected, _) = fixture();
    write_link(home.path(), &snapshot, 0.0);
    for (body, status) in [
        ("{}", "200 OK"),
        ("{", "200 OK"),
        ("{}", "503 Service Unavailable"),
        ("{}", "302 Found"),
    ] {
        let (port, thread) = server(body.into(), status);
        let o = line_command(home.path(), port).output().unwrap();
        assert!(o.status.success());
        assert_eq!(String::from_utf8(o.stdout).unwrap(), expected);
        thread.join().unwrap();
    }
}
#[test]
fn canonical_executable_sibling_and_pacer_bin_are_used() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let links = dir.path().join("links");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&links).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_pacer"), real.join("pacer")).unwrap();
    fs::write(
        real.join("pacer-core"),
        "#!/bin/sh\nprintf '%s|%s' \"$*\" \"$PACER_BIN\"\n",
    )
    .unwrap();
    fs::set_permissions(real.join("pacer-core"), fs::Permissions::from_mode(0o755)).unwrap();
    symlink(real.join("pacer"), links.join("pacer")).unwrap();
    let expected_bin = fs::canonicalize(real.join("pacer")).unwrap();
    for args in [vec![], vec!["help"], vec!["version", "extra"]] {
        let o = Command::new(links.join("pacer"))
            .env_remove("PACER_CORE_ARGV")
            .env_remove("PACER_BIN")
            .args(&args)
            .output()
            .unwrap();
        assert!(o.status.success());
        assert_eq!(
            String::from_utf8(o.stdout).unwrap(),
            format!("{}|{}", args.join(" "), expected_bin.display())
        );
    }
}

#[test]
fn offline_json_preserves_typescript_field_order() {
    let home = tempfile::tempdir().unwrap();
    let o = line_command(home.path(), 0).arg("--json").output().unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        "{\"online\":false,\"planner\":null,\"agent\":null,\"usedPct\":null,\"pacePct\":null,\"verdict\":null,\"resetsAt\":null,\"running\":null,\"attention\":null,\"mode\":null}\n"
    );
}

#[test]
fn line_flags_tolerate_unknown_arguments_and_preserve_pacer_off_behavior() {
    let home = tempfile::tempdir().unwrap();
    let (snapshot, _, _) = fixture();
    write_link(home.path(), &snapshot, 0.0);
    let o = line_command(home.path(), 0)
        .env("PACER", "off")
        .args(["--unknown", "--width", "invalid", "--width", "20"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(o.stdout, "▬┃63 ⚑4\n".as_bytes());
    let mut disabled = snapshot;
    disabled["disabled"] = serde_json::json!(true);
    write_link(home.path(), &disabled, 0.0);
    let o = line_command(home.path(), 0).output().unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(o.stdout, b"pacer off (PACER=off)\n");
}
