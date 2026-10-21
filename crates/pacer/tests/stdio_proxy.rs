#![allow(clippy::unwrap_used)]
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::PermissionsExt,
    process::{Command, Output, Stdio},
};

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
        .env_remove("PACER_BIN");
    command
}

#[test]
fn forwards_original_bytes_and_drains_on_eof() {
    let home = tempfile::tempdir().unwrap();
    let script = home.path().join("core");
    fs::write(&script, "#!/bin/sh\n[ \"$1\" = prefix ] && [ \"$2\" = api ] && [ \"$3\" = --stdio ] && [ -n \"$PACER_BIN\" ] || exit 9\ncat\nprintf 'final response without newline'\nexit 7\n").unwrap();
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
            "printf 'done\\n'; exit 4".into(),
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
        .env("PACER_HOME", direct_home.path());
    let expected = exchange_with_events(direct, input.clone(), true);
    let actual = exchange_with_events(proxy(&["bun".into(), cli], proxy_home.path()), input, true);
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
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        lines.sort_by_key(|line| line["id"].to_string());
        lines
    };
    assert_eq!(parse(&actual.stdout), parse(&expected.stdout));
    assert_eq!(parse(&actual.stdout).len(), 6);
    assert!(
        parse(&actual.stdout)
            .iter()
            .any(|line| line["method"] == "event")
    );
}
