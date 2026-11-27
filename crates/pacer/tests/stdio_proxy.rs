#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::PermissionsExt,
    process::{Child, ChildStdin, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
#[path = "support/keychain_stub.rs"]
mod keychain_stub;

fn exchange(command: Command, input: Vec<u8>) -> Output {
    exchange_with_events(command, input, false)
}

fn exchange_with_events(mut command: Command, input: Vec<u8>, events: bool) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    if events {
        stdin.write_all(&input).unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut bytes = Vec::new();
        loop {
            let mut line = Vec::new();
            assert!(reader.read_until(b'\n', &mut line).unwrap() > 0);
            let value: serde_json::Value = serde_json::from_slice(&line).unwrap();
            bytes.extend(line);
            if value["method"] == "event" {
                break;
            }
        }
        drop(stdin);
        reader.read_to_end(&mut bytes).unwrap();
        let mut output = child.wait_with_output().unwrap();
        output.stdout = bytes;
        return output;
    }
    let writer = std::thread::spawn(move || stdin.write_all(&input).unwrap());
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    output
}

fn proxy(core: &[String], home: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pacer"));
    command
        .args(["api", "--stdio"])
        .env("PACER_CORE_ARGV", serde_json::to_string(core).unwrap())
        .env("PACER_HOME", home)
        .env("PATH", keychain_stub::keychain_stub_path(home, "bun"))
        .env_remove("PACER_BIN");
    command
}

#[test]
fn forwards_original_bytes_and_drains_on_eof() {
    let home = tempfile::tempdir().unwrap();
    let script = home.path().join("core");
    // Like Core, the stub reads exactly its secrets frame before the forwarded bytes.
    fs::write(&script, "#!/bin/sh\n[ \"$1\" = prefix ] && [ \"$2\" = api ] && [ \"$3\" = --stdio ] && [ -n \"$PACER_BIN\" ] || exit 9\n[ \"$PACER_CORE_SECRETS\" = stdin/1 ] && [ -z \"${PACER_NATIVE_CONFIG_SYNC_KEY+set}\" ] || exit 10\nIFS= read -r header || exit 11\ncase \"$header\" in \"pacer-core-secrets/1 \"*) ;; *) exit 12 ;; esac\ndd bs=1 count=\"${header#pacer-core-secrets/1 }\" of=/dev/null 2>/dev/null || exit 13\ncat\nprintf 'final response without newline'\nexit 7\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let mut input = b"  { \"method\" : \"forward\", \"id\": 1 }\r\ninvalid\n\xff\n".to_vec();
    // The server has no line cap, including for invalid JSON and partial lines.
    input.extend(vec![b'x'; 1024 * 1024 + 1]);
    let output = exchange(
        proxy(
            &[script.to_string_lossy().into_owned(), "prefix".into()],
            home.path(),
        ),
        input.clone(),
    );
    assert_eq!(output.status.code(), Some(7));
    input.extend_from_slice(b"final response without newline");
    assert_eq!(output.stdout, input);
}

#[test]
fn core_exit_does_not_wait_for_client_eof() {
    let home = tempfile::tempdir().unwrap();
    let mut command = proxy(
        &[
            "/bin/sh".into(),
            "-c".into(),
            // Like Core, the stub consumes the secrets frame before writing;
            // otherwise the door's frame write races this core's instant exit.
            "IFS= read -r header || exit 11; printf 'done\\n'; exit 4".into(),
        ],
        home.path(),
    );
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(line, "done\n");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(4));
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("proxy waited for client EOF after core exited");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    drop(stdin);
}

#[test]
fn forwards_hello_ops_and_events_unchanged() {
    if Command::new("bun").arg("--version").output().is_err() {
        eprintln!("SKIP: bun is absent");
        return;
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cli = repo.join("src/cli.ts").to_string_lossy().into_owned();
    let direct_home = tempfile::tempdir().unwrap();
    let proxy_home = tempfile::tempdir().unwrap();
    for home in [&direct_home, &proxy_home] {
        fs::create_dir_all(home.path().join("link")).unwrap();
        fs::write(home.path().join("link/outbox.jsonl"), "{\"seq\":1,\"at\":123,\"envelope\":{\"type\":\"mode\",\"data\":{\"mode\":\"normal\",\"previous\":null,\"strategy\":\"test\",\"at\":123}}}\n").unwrap();
    }
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"version.get\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"subscribe\",\"params\":{\"since\":0}}\n{broken\n{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"not.an.op\"}\n".to_vec();
    let mut direct = Command::new("bun");
    direct
        .args([&cli, "api", "--stdio"])
        .env("PACER_HOME", direct_home.path())
        .env(
            "PATH",
            keychain_stub::keychain_stub_path(direct_home.path(), "bun"),
        );
    let expected = exchange_with_events(direct, input.clone(), true);
    let mut command = proxy(&["bun".into(), cli], proxy_home.path());
    command.env("PACER_DEBUG_NATIVE", "1");
    let actual = exchange_with_events(command, input, true);
    assert!(
        expected.status.success(),
        "{}",
        String::from_utf8_lossy(&expected.stderr)
    );
    assert!(
        actual.status.success(),
        "{}",
        String::from_utf8_lossy(&actual.stderr)
    );
    let parse = |bytes: &[u8]| {
        let mut lines: Vec<serde_json::Value> = bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
            // Event notifications have no id, so their arrival order against
            // id:null replies is not significant; compare the five replies.
            .filter(|line| line["method"] != "event")
            .collect();
        lines.sort_by_key(|line| line["id"].to_string());
        lines
    };
    assert_eq!(parse(&actual.stdout), parse(&expected.stdout));
    assert_eq!(parse(&actual.stdout).len(), 5);
    assert!(String::from_utf8_lossy(&actual.stderr).contains("native hello 1"));
    assert!(
        actual
            .stdout
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
            .any(|line| line["method"] == "event")
    );
}

#[test]
fn hello_negotiates_v2_v3_and_preserves_validation() {
    if Command::new("bun").arg("--version").output().is_err() {
        return;
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cli = repo.join("src/cli.ts").to_string_lossy().into_owned();
    let home = tempfile::tempdir().unwrap();
    let cases = [
        None,
        Some("3"),
        Some("4"),
        Some("[]"),
        Some("2e0"),
        Some("3.0"),
        Some("3e0"),
        Some("9007199254740992"),
        Some("null"),
        Some("\"3\""),
        Some("true"),
    ];
    let input = cases
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let params = match value {
                None => String::new(),
                Some("[]") => ",\"params\":[]".to_owned(),
                Some(value) => format!(",\"params\":{{\"protocol\":{value}}}"),
            };
            format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":\"hello\"{params}}}\n",
                index + 1
            )
        })
        .collect::<String>()
        .into_bytes();
    let mut direct = Command::new("bun");
    direct
        .args([&cli, "api", "--stdio"])
        .env("PACER_HOME", home.path())
        .env(
            "PATH",
            keychain_stub::keychain_stub_path(home.path(), "bun"),
        );
    let expected = exchange(direct, input.clone());
    let mut command = proxy(&["bun".into(), cli], home.path());
    command.env("PACER_DEBUG_NATIVE", "1");
    let actual = exchange(command, input);
    assert!(expected.status.success());
    assert!(actual.status.success());
    let parse = |bytes: &[u8]| -> Vec<serde_json::Value> {
        bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    };
    assert_eq!(parse(&actual.stdout), parse(&expected.stdout));
    let stderr = String::from_utf8_lossy(&actual.stderr);
    for id in [1, 2, 5, 6, 7, 9] {
        assert!(stderr.contains(&format!("native hello {id}")), "{stderr}");
    }
}

#[test]
fn forward_override_disables_hello_and_preserves_protocol() {
    if Command::new("bun").arg("--version").output().is_err() {
        return;
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cli = repo.join("src/cli.ts").to_string_lossy().into_owned();
    let home = tempfile::tempdir().unwrap();
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"hello\",\"params\":{\"protocol\":2}}\n".to_vec();
    for forward in ["*", "hello", "test.echo, hello"] {
        let mut command = proxy(&["bun".into(), cli.clone()], home.path());
        command
            .env("PACER_FORWARD_OPS", forward)
            .env("PACER_DEBUG_NATIVE", "1");
        let output = exchange(command, input.clone());
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let replies: Vec<serde_json::Value> = output
            .stdout
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["result"]["protocol"], "3.0.0");
        assert_eq!(replies[1]["result"]["protocol"], "2.8.0");
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("native hello"),
            "{forward}"
        );
    }
}

#[test]
fn hello_keeps_work_grant_snapshot_and_subscribe_scoped() {
    if Command::new("bun").arg("--version").output().is_err() {
        return;
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cli = repo.join("src/cli.ts").to_string_lossy().into_owned();
    let home = tempfile::tempdir().unwrap();
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"snapshot\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"subscribe\"}\n".to_vec();
    let mut direct = Command::new("bun");
    direct
        .args([&cli, "api", "--stdio"])
        .env("PACER_HOME", home.path())
        .env("PACER_WORK_GRANT", "invalid-but-present")
        .env(
            "PATH",
            keychain_stub::keychain_stub_path(home.path(), "bun"),
        );
    let expected = exchange(direct, input.clone());
    let mut root = proxy(&["bun".into(), cli], home.path());
    root.env("PACER_WORK_GRANT", "invalid-but-present");
    let actual = exchange(root, input);
    assert!(expected.status.success());
    assert!(actual.status.success());
    let parse = |bytes: &[u8]| -> Vec<serde_json::Value> {
        bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    };
    let actual = parse(&actual.stdout);
    assert_eq!(actual, parse(&expected.stdout));
    assert_eq!(actual[1]["error"]["data"]["code"], "not_allowed");
    assert_eq!(actual[2]["error"]["data"]["code"], "not_allowed");
}

#[test]
fn run_grant_and_orchestrator_sessions_are_authorized_by_the_core_alone() {
    // API-5b: a `prg_` session is never the operator, so no operation runs natively.
    if Command::new("bun").arg("--version").output().is_err() {
        return;
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cli = repo.join("src/cli.ts").to_string_lossy().into_owned();
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"version.get\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"task.list\",\"params\":{}}\n".to_vec();
    let grant = format!("prg_{}", "a".repeat(64));
    for (name, value) in [
        ("PACER_RUN_GRANT", grant.as_str()),
        ("PACER_ROLE", "orchestrator"),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut command = proxy(&["bun".into(), cli.clone()], home.path());
        command.env(name, value).env("PACER_DEBUG_NATIVE", "1");
        let output = exchange(command, input.clone());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{name}: {stderr}");
        assert!(!stderr.contains("native "), "{name}: {stderr}");
        let replies: Vec<serde_json::Value> = output
            .stdout
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        for id in [2, 3] {
            let reply = replies.iter().find(|reply| reply["id"] == id).unwrap();
            assert_eq!(
                reply["error"]["data"]["code"], "not_allowed",
                "{name}: {reply}"
            );
        }
    }
}

/// Whether any file under `dir` mentions `needle`.
fn mentions(dir: &std::path::Path, needle: &str) -> bool {
    std::fs::read_dir(dir).unwrap().any(|entry| {
        let path = entry.unwrap().path();
        if path.is_dir() {
            mentions(&path, needle)
        } else {
            std::fs::read(&path).is_ok_and(|bytes| String::from_utf8_lossy(&bytes).contains(needle))
        }
    })
}

#[test]
fn enforcement_and_assistant_identities_are_authorized_by_the_core_alone() {
    // API-5: a `pet_` or `pag_` session is never the operator, so `repo.add` reaches the core's
    // refusal and persists nothing, even with a token no store knows.
    if Command::new("bun").arg("--version").output().is_err() {
        return;
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cli = repo.join("src/cli.ts").to_string_lossy().into_owned();
    let target = tempfile::tempdir().unwrap();
    let checkout = target.path().join("scoped-identity-checkout");
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .arg(&checkout)
            .status()
            .unwrap()
            .success()
    );
    let input = format!(
        "{}\n{}\n",
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"repo.add","params":{"path":checkout}}),
    )
    .into_bytes();
    let registered = |home: &std::path::Path| mentions(home, "scoped-identity-checkout");

    // The control: without a scoped identity the same request registers the repository.
    let home = tempfile::tempdir().unwrap();
    let output = exchange(
        proxy(&["bun".into(), cli.clone()], home.path()),
        input.clone(),
    );
    assert!(output.status.success());
    assert!(registered(home.path()));

    for (name, value) in [
        ("PACER_ENFORCEMENT_TOKEN", "pet_junk"),
        ("PACER_ASSISTANT_GRANT", "pag_junk"),
    ] {
        let direct_home = tempfile::tempdir().unwrap();
        let mut direct = Command::new("bun");
        direct
            .args([&cli, "api", "--stdio"])
            .env("PACER_HOME", direct_home.path())
            .env(
                "PATH",
                keychain_stub::keychain_stub_path(direct_home.path(), "bun"),
            )
            .env(name, value);
        let expected = exchange(direct, input.clone());
        let home = tempfile::tempdir().unwrap();
        let mut command = proxy(&["bun".into(), cli.clone()], home.path());
        command.env(name, value).env("PACER_DEBUG_NATIVE", "1");
        let actual = exchange(command, input.clone());
        let stderr = String::from_utf8_lossy(&actual.stderr);
        assert!(!registered(home.path()), "{name}: {stderr}");
        assert!(!stderr.contains("native "), "{name}: {stderr}");
        assert_eq!(
            actual.status.code(),
            expected.status.code(),
            "{name}: {stderr}"
        );
        let parse = |bytes: &[u8]| -> Vec<serde_json::Value> {
            bytes
                .split(|b| *b == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice(line).unwrap())
                .collect()
        };
        assert_eq!(parse(&actual.stdout), parse(&expected.stdout), "{name}");
        if name == "PACER_ENFORCEMENT_TOKEN" {
            let replies = parse(&actual.stdout);
            assert_eq!(replies[1]["error"]["data"]["code"], "not_allowed");
        } else {
            // The CLI refuses the whole transport for an assistant grant.
            assert!(stderr.contains("an assistant grant only allows the MCP server"));
        }
    }
}

/// A Core double: it consumes the secrets frame, records every request line and
/// answers only the snapshot probe bridge. It stays alive briefly after EOF so
/// a subscription whose timer was not cleared would emit another event.
fn recording_core(home: &std::path::Path, parts: &Value) -> (Vec<String>, std::path::PathBuf) {
    let script = home.join("core-double");
    let parts_file = home.join("snapshot-parts.json");
    let record = home.join("core-input.jsonl");
    fs::write(&parts_file, serde_json::to_string(parts).unwrap()).unwrap();
    fs::write(
        &script,
        r#"#!/bin/sh
PARTS="$1"
RECORD="$2"
IFS= read -r header || exit 11
dd bs=1 count="${header#pacer-core-secrets/1 }" of=/dev/null 2>/dev/null || exit 13
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$RECORD"
  case "$line" in
    *'"_internal.snapshot-probe.parts"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":"%s","result":%s}\n' "$id" "$(cat "$PARTS")"
      ;;
  esac
done
sleep 2
"#,
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    (
        vec![
            script.to_string_lossy().into_owned(),
            parts_file.to_string_lossy().into_owned(),
            record.to_string_lossy().into_owned(),
        ],
        record,
    )
}

fn snapshot_parts() -> Value {
    json!({
        "revision": "abc",
        "active": [],
        "alivePids": [],
        "setup": {"open": 0, "items": []},
        "policy": {},
        "machine": {"os": "darwin", "arch": "arm64"},
        "service": {"version": "0.0.0", "protocol": "3.0.0", "pid": 1, "startedAt": 0, "notifier": null},
        "desktopUpdates": [],
        "serviceInstalled": false,
        "canPair": true,
        "status": {"generatedAt": 1.0, "strategy": "s", "planner": "p", "mode": "normal", "disabled": false, "calendarPace": false, "providers": [], "executors": {"ranked": [], "excluded": []}},
    })
}

fn seed_event(home: &std::path::Path) {
    fs::create_dir_all(home.join("link")).unwrap();
    fs::write(
        home.join("link/outbox.jsonl"),
        "{\"seq\":1,\"at\":123,\"envelope\":{\"type\":\"mode\",\"data\":{\"mode\":\"normal\",\"previous\":null,\"strategy\":\"test\",\"at\":123}}}\n",
    )
    .unwrap();
}

/// A door whose stdout lines are collected so requests can be interleaved with reads.
struct Interactive {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Value>,
    stderr: thread::JoinHandle<String>,
    collected: Vec<Value>,
}

impl Interactive {
    fn start(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        let stderr = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        });
        Self {
            child,
            stdin,
            lines,
            stderr,
            collected: Vec::new(),
        }
    }

    fn send(&mut self, value: Value) {
        writeln!(self.stdin, "{}", serde_json::to_string(&value).unwrap()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn wait_for<F: Fn(&Value) -> bool>(&self, accept: F, timeout: Duration) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match self.lines.recv_timeout(remaining) {
                Ok(value) => {
                    if accept(&value) {
                        return Some(value);
                    }
                }
                Err(_) => return None,
            }
        }
    }

    fn drain(mut self) -> (Vec<Value>, String, i32) {
        drop(self.stdin);
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match self.lines.recv_timeout(Duration::from_millis(100)) {
                Ok(value) => self.collected.push(value),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.child.try_wait().unwrap().is_some() {
                        break;
                    }
                }
            }
        }
        let status = match self.child.try_wait().unwrap() {
            Some(status) => status,
            None => {
                self.child.kill().unwrap();
                self.child.wait().unwrap()
            }
        };
        let stderr = self.stderr.join().unwrap();
        (self.collected, stderr, status.code().unwrap_or(1))
    }
}

#[test]
fn subscribe_streams_events_without_core_and_stops_at_eof() {
    let home = tempfile::tempdir().unwrap();
    seed_event(home.path());
    let (core, record) = recording_core(home.path(), &snapshot_parts());
    let mut session = Interactive::start(proxy(&core, home.path()));
    session.send(json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}));
    session.send(json!({"jsonrpc":"2.0","id":2,"method":"subscribe","params":{"since":0}}));
    let first = session.wait_for(|line| line["method"] == "event", Duration::from_secs(15));
    assert!(first.is_some(), "no event notification arrived");
    assert_eq!(first.unwrap()["params"]["type"], "mode");
    // Keep stdin open: a timer that was not cleared would replay the event at 500 ms.
    assert!(
        session
            .wait_for(|line| line["method"] == "event", Duration::from_millis(1200))
            .is_none(),
        "a duplicate event arrived while the subscription was live"
    );
    let (lines, stderr, code) = session.drain();
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        lines.iter().filter(|line| line["method"] == "event").count(),
        0,
        "an event arrived after EOF cleared the timer"
    );
    let recorded = fs::read_to_string(&record).unwrap_or_default();
    assert!(!recorded.contains("\"subscribe\""), "subscribe reached Core: {recorded}");
    assert!(!recorded.contains("\"snapshot\""), "snapshot reached Core: {recorded}");
}

#[test]
fn subscribe_rejects_a_negative_since_like_typescript() {
    let home = tempfile::tempdir().unwrap();
    let (core, record) = recording_core(home.path(), &snapshot_parts());
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"subscribe\",\"params\":{\"since\":-1}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"subscribe\",\"params\":{\"since\":1.5}}\n".to_vec();
    let output = exchange(proxy(&core, home.path()), input);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let lines: Vec<Value> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    for id in [2, 3] {
        let reply = lines.iter().find(|line| line["id"] == id).unwrap();
        assert_eq!(reply["error"]["code"], -32602, "{reply}");
        assert_eq!(reply["error"]["data"]["code"], "invalid_input", "{reply}");
        assert_eq!(reply["error"]["message"], "since must be a non-negative integer", "{reply}");
    }
    let recorded = fs::read_to_string(&record).unwrap_or_default();
    assert!(!recorded.contains("\"subscribe\""), "subscribe reached Core: {recorded}");
}

#[test]
fn subscribe_without_params_defaults_to_zero_like_typescript() {
    let home = tempfile::tempdir().unwrap();
    let (core, record) = recording_core(home.path(), &snapshot_parts());
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"subscribe\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"subscribe\",\"params\":null}\n".to_vec();
    let output = exchange(proxy(&core, home.path()), input);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let lines: Vec<Value> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    for id in [2, 3] {
        let reply = lines.iter().find(|line| line["id"] == id).unwrap();
        assert_eq!(reply["result"]["subscribed"], true, "{reply}");
        assert_eq!(reply["result"]["last"], 3_000_000_000_000.0, "{reply}");
    }
    let recorded = fs::read_to_string(&record).unwrap_or_default();
    assert!(!recorded.contains("\"subscribe\""), "subscribe reached Core: {recorded}");
}

#[test]
fn hello_resets_the_subscription() {
    let home = tempfile::tempdir().unwrap();
    seed_event(home.path());
    let (core, _record) = recording_core(home.path(), &snapshot_parts());
    let mut session = Interactive::start(proxy(&core, home.path()));
    session.send(json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}));
    session.send(json!({"jsonrpc":"2.0","id":2,"method":"subscribe","params":{"since":0}}));
    assert!(
        session
            .wait_for(|line| line["method"] == "event", Duration::from_secs(15))
            .is_some(),
        "the first subscription did not stream"
    );
    // A changed protocol clears the timer, as in stdio.ts:336.
    session.send(json!({"jsonrpc":"2.0","id":3,"method":"hello","params":{"protocol":2}}));
    assert!(
        session
            .wait_for(|line| line["method"] == "event", Duration::from_millis(1200))
            .is_none(),
        "hello did not stop the event timer"
    );
    session.send(json!({"jsonrpc":"2.0","id":4,"method":"subscribe","params":{"since":0}}));
    assert!(
        session
            .wait_for(|line| line["method"] == "event", Duration::from_secs(15))
            .is_some(),
        "a fresh subscribe after hello did not stream"
    );
    let (_, stderr, code) = session.drain();
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn snapshot_v2_and_v3_shapes() {
    let home = tempfile::tempdir().unwrap();
    let (core, record) = recording_core(home.path(), &snapshot_parts());
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":3}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"snapshot\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"hello\",\"params\":{\"protocol\":2}}\n{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"snapshot\"}\n".to_vec();
    let output = exchange(proxy(&core, home.path()), input);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let lines: Vec<Value> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    let v3 = lines.iter().find(|line| line["id"] == 2).unwrap();
    assert_eq!(v3["result"]["protocol"], "3.0.0", "{v3}");
    assert!(v3["result"]["snapshot"]["runs"].is_array(), "{v3}");
    assert!(v3["result"]["snapshot"]["desktopUpdates"].is_array(), "{v3}");
    let v2 = lines.iter().find(|line| line["id"] == 4).unwrap();
    assert_eq!(v2["result"]["protocol"], "2.8.0", "{v2}");
    assert!(v2["result"]["snapshot"].get("runs").is_none(), "{v2}");
    let recorded = fs::read_to_string(&record).unwrap_or_default();
    assert!(!recorded.contains("\"snapshot\""), "snapshot reached Core: {recorded}");
    assert_eq!(
        recorded.matches("_internal.snapshot-probe.parts").count(),
        2,
        "{recorded}"
    );
}
