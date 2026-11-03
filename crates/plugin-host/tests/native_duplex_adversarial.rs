#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use pacer_plugin_host::{BrokerError, DuplexSpec, NativeDuplex};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new(body: &str) -> (Self, NativeDuplex) {
        let root =
            std::env::temp_dir().join(format!("pacer-duplex-adversarial-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let executable = root.join("ssh");
        fs::write(&executable, format!("#!/usr/bin/env python3\n{body}\n")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let native = NativeDuplex::prepare(DuplexSpec {
            argv: vec!["ssh".into()],
            executable: executable.to_str().unwrap().into(),
            env: HashMap::from([("PATH".into(), std::env::var("PATH").unwrap())]),
            input: vec![],
            timeout_ms: 1000,
        })
        .unwrap();
        (Self(root), native)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
async fn open(stream: &mut NativeDuplex) -> Value {
    stream
        .answer(
            "capability.process.duplex.open",
            &json!({"argv":["ssh"],"timeoutMs":1000}),
            deadline(),
        )
        .await
        .unwrap()["handle"]
        .clone()
}
async fn ready(stream: &mut NativeDuplex, handle: &Value) {
    let r = stream
        .answer(
            "capability.process.duplex.read",
            &json!({"handle":handle,"length":64,"timeoutMs":1000}),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(r["base64"], STANDARD.encode(b"ready\n"));
}
#[tokio::test]
async fn graceful_close_preserves_both_exit_codes_and_preexit_output() {
    for code in [0, 7] {
        for early in [false, true] {
            let body = format!(
                "import sys\nprint('ready',flush=True)\n{}\nsys.exit({code})",
                if early {
                    "pass"
                } else {
                    "sys.stdin.buffer.read()"
                }
            );
            let (_f, mut stream) = Fixture::new(&body);
            let h = open(&mut stream).await;
            if !early {
                ready(&mut stream, &h).await;
            }
            let r = stream
                .answer(
                    "capability.process.duplex.close",
                    &json!({"handle":h,"graceful":true}),
                    deadline(),
                )
                .await
                .unwrap();
            assert_eq!(r["code"], code, "early={early}");
            assert_eq!(r["signal"], Value::Null);
            assert_eq!(r["terminated"], false);
        }
    }
}
#[tokio::test]
async fn timed_out_read_retires_the_handle_and_reaps_the_child() {
    let (_f, mut stream) = Fixture::new("import time\nprint('ready',flush=True)\ntime.sleep(60)");
    let h = open(&mut stream).await;
    ready(&mut stream, &h).await;
    let r = stream
        .answer(
            "capability.process.duplex.read",
            &json!({"handle":h,"length":64,"timeoutMs":20}),
            deadline(),
        )
        .await;
    assert!(matches!(r, Err(BrokerError::Timeout)));
    assert!(
        stream
            .answer(
                "capability.process.duplex.read",
                &json!({"handle":h,"length":64,"timeoutMs":100}),
                deadline()
            )
            .await
            .is_err()
    );
    assert!(
        stream
            .answer(
                "capability.process.duplex.open",
                &json!({"argv":["ssh"],"timeoutMs":1000}),
                deadline()
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn failed_and_blocked_stdin_retire_without_issuing_a_receipt() {
    for close_stdin in [true, false] {
        let body = format!(
            "import os,time\n{}\nprint('ready',flush=True)\ntime.sleep(60)",
            if close_stdin { "os.close(0)" } else { "pass" }
        );
        let (_f, mut stream) = Fixture::new(&body);
        let h = open(&mut stream).await;
        ready(&mut stream, &h).await;
        let frame = vec![b'x'; 65536];
        let mut failed = false;
        for sequence in 0..32 {
            stream.issue_input(sequence, frame.clone()).unwrap();
            let result = stream
                .answer(
                    "capability.process.duplex.write",
                    &json!({"handle":h,"base64":STANDARD.encode(&frame),"timeoutMs":20}),
                    deadline(),
                )
                .await;
            if result.is_err() {
                assert!(stream.acknowledge_input(sequence).is_err());
                assert!(
                    stream
                        .answer(
                            "capability.process.duplex.close",
                            &json!({"handle":h}),
                            deadline()
                        )
                        .await
                        .is_err()
                );
                failed = true;
                break;
            }
            stream.acknowledge_input(sequence).unwrap();
        }
        assert!(
            failed,
            "bounded pipe unexpectedly accepted 2 MiB without a reader"
        );
    }
}
#[tokio::test]
async fn exited_leader_does_not_strand_a_pipe_holding_descendant() {
    let (_f, mut stream) = Fixture::new(
        "import os,signal,time\nchild=os.fork()\nif child==0:\n signal.signal(signal.SIGTERM,lambda *_: os._exit(0))\n print('ready',flush=True)\n time.sleep(60)\n os._exit(0)\ntime.sleep(.05)\nos._exit(0)",
    );
    let h = open(&mut stream).await;
    ready(&mut stream, &h).await;
    let r = stream
        .answer(
            "capability.process.duplex.close",
            &json!({"handle":h,"graceful":true}),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(r["code"], 0);
    assert_eq!(r["terminated"], true);
}
#[tokio::test]
async fn owned_revoke_waits_for_the_exact_duplex_child_to_be_reaped() {
    let (_f, mut stream) = Fixture::new(
        "import sys,os,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('ready',flush=True)\nwhile True: time.sleep(1)",
    );
    let handle = open(&mut stream).await;
    ready(&mut stream, &handle).await;
    stream.revoke();
    stream.retire_owned().await.unwrap();
    assert!(
        stream
            .answer(
                "capability.process.duplex.read",
                &json!({"handle":handle,"length":1,"timeoutMs":1000}),
                deadline()
            )
            .await
            .is_err()
    );
}
