#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn snapshot() -> Value {
    serde_json::from_str(include_str!("../../../test/fixtures/ui/snapshot.json")).unwrap()
}

#[test]
fn backend_policy_facts_survive_native_snapshot_and_classic_fields() {
    for policy in [
        json!({"mode":"closed","plugins":0}),
        json!({"mode":"open","plugins":2}),
    ] {
        let mut input = snapshot();
        input["policy"] = policy.clone();
        assert_eq!(
            pacer_cli::status_line::fields(Some(&input))["policy"],
            policy
        );
        let classic = json!({"generatedAt":100,"planner":"codex","mode":"normal","providers":[{"id":"codex","agent":"codex","verdict":"OK"}],"policy":policy});
        assert_eq!(
            pacer_cli::status_line::fields(Some(&classic))["policy"],
            policy
        );
    }
    assert!(
        pacer_cli::status_line::fields(Some(&snapshot()))
            .get("policy")
            .is_none()
    );
}

#[test]
fn native_compact_policy_keeps_attention_and_real_zero_counts() {
    let mut input = snapshot();
    for (policy, expected) in [
        (None, "policy:unknown ⚑4"),
        (Some(json!({"mode":"open","plugins":0})), "policy:open/0 ⚑4"),
        (
            Some(json!({"mode":"closed","plugins":0})),
            "policy:closed/0 ⚑4",
        ),
        (
            Some(json!({"mode":"closed","plugins":2})),
            "policy:closed/2 ⚑4",
        ),
    ] {
        if let Some(policy) = policy {
            input["policy"] = policy;
        } else {
            input.as_object_mut().unwrap().remove("policy");
        }
        assert_eq!(
            pacer_cli::status_line::render(Some(&input), 20, false),
            expected
        );
        for width in [40, 60, 80, 120] {
            let line = pacer_cli::status_line::render(Some(&input), width, false);
            assert!(line.contains("policy:"), "{line}");
            assert!(line.contains("⚑4"), "{line}");
            assert!(line.encode_utf16().count() <= width, "{line}");
        }
    }
    input["policy"] = json!({"mode":"closed","plugins":123456});
    assert_eq!(
        pacer_cli::status_line::render(Some(&input), 20, false),
        "policy:closed/123456"
    );
}

#[test]
fn native_status_line_route_reads_policy_from_the_authenticated_backend() {
    if let Ok(args) = std::env::var("PACER_NATIVE_POLICY_ROUTE_ARGS") {
        let argv: Vec<String> = serde_json::from_str(&args).unwrap();
        std::process::exit(pacer_cli::main(argv));
    }
    let home = std::env::temp_dir().join(format!(
        "pacer-native-policy-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("token"), "owned-fixture-token").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let mut input = snapshot();
    input["policy"] = json!({"mode":"closed","plugins":0});
    let body = json!({"snapshot":input}).to_string();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut requests = 0;
        while requests < 2 && Instant::now() < deadline {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0 && bytes.len() + n <= 16_384);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let request = String::from_utf8_lossy(&bytes);
            assert!(request.starts_with("GET /v2/snapshot "));
            assert!(
                request
                    .to_lowercase()
                    .contains("authorization: bearer owned-fixture-token")
            );
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            requests += 1;
        }
        requests
    });
    let run = |args: &[&str]| {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_status_line_route_reads_policy_from_the_authenticated_backend",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", &home)
            .env("PACER_HOME", &home)
            .env("PACER_PORT", port.to_string())
            .env(
                "PACER_NATIVE_POLICY_ROUTE_ARGS",
                serde_json::to_string(args).unwrap(),
            )
            .output()
            .unwrap()
    };
    let fields = run(&["pacer", "status", "--line", "--json"]);
    let line = run(&["pacer", "status", "--line", "--no-color", "--width", "20"]);
    let requests = server.join().unwrap();
    std::fs::remove_dir_all(home).unwrap();
    assert_eq!(requests, 2);
    assert!(fields.status.success());
    let output = String::from_utf8(fields.stdout).unwrap();
    let fields: Value = output
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .unwrap();
    assert_eq!(fields["policy"], json!({"mode":"closed","plugins":0}));
    assert!(line.status.success());
    assert!(
        String::from_utf8(line.stdout)
            .unwrap()
            .contains("policy:closed/0 ⚑4")
    );
}
