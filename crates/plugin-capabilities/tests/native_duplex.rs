#![allow(clippy::unwrap_used)]
use pacer_plugin_capabilities::{DuplexSpec, NativeDuplex};
use serde_json::json;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
#[tokio::test]
async fn duplex_only_accepts_the_issued_frame_once_and_owns_its_handle() {
    let spec = DuplexSpec {
        argv: vec!["ssh".into()],
        executable: "/bin/cat".into(),
        env: HashMap::new(),
        input: b"issued-frame\n".to_vec(),
        timeout_ms: 1000,
    };
    let mut stream = NativeDuplex::prepare(spec).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let open = stream
        .answer(
            "capability.process.duplex.open",
            &json!({"argv":["ssh"],"timeoutMs":1000}),
            deadline,
        )
        .await
        .unwrap();
    let handle = open["handle"].as_str().unwrap();
    assert!(
        stream
            .answer(
                "capability.process.duplex.write",
                &json!({"handle":handle,"base64":"ZXZpbA==","timeoutMs":1000}),
                deadline
            )
            .await
            .is_err()
    );
    assert!(
        stream
            .answer(
                "capability.process.duplex.read",
                &json!({"handle":"foreign","length":64,"timeoutMs":1000}),
                deadline
            )
            .await
            .is_err()
    );
    assert!(
        stream
            .answer(
                "capability.process.duplex.write",
                &json!({"handle":handle,"base64":"aXNzdWVkLWZyYW1lCg==","timeoutMs":1000}),
                deadline
            )
            .await
            .is_ok()
    );
    let read = stream
        .answer(
            "capability.process.duplex.read",
            &json!({"handle":handle,"length":64,"timeoutMs":1000}),
            deadline,
        )
        .await
        .unwrap();
    assert_eq!(read["base64"], "aXNzdWVkLWZyYW1lCg==");
    assert!(
        stream
            .answer(
                "capability.process.duplex.write",
                &json!({"handle":handle,"base64":"aXNzdWVkLWZyYW1lCg==","timeoutMs":1000}),
                deadline
            )
            .await
            .is_err()
    );
    stream
        .answer(
            "capability.process.duplex.close",
            &json!({"handle":handle}),
            deadline,
        )
        .await
        .unwrap();
    assert!(
        stream
            .answer(
                "capability.process.duplex.open",
                &json!({"argv":["ssh"],"timeoutMs":1000}),
                deadline
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn duplex_close_reports_node_signal_names() {
    let mut stream = NativeDuplex::prepare(DuplexSpec {
        argv: vec!["ssh".into()],
        executable: "/bin/cat".into(),
        env: HashMap::new(),
        input: vec![],
        timeout_ms: 1000,
    })
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let open = stream
        .answer(
            "capability.process.duplex.open",
            &json!({"argv":["ssh"],"timeoutMs":1000}),
            deadline,
        )
        .await
        .unwrap();
    let closed = stream
        .answer(
            "capability.process.duplex.close",
            &json!({"handle":open["handle"]}),
            deadline,
        )
        .await
        .unwrap();
    assert_eq!(closed["signal"], "SIGTERM");
}
#[tokio::test]
async fn duplex_uses_the_typescript_half_second_term_grace() {
    use std::fs;
    let root = std::env::temp_dir().join(format!("pacer-duplex-grace-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let script = root.join("child.py");
    fs::write(&script,"import signal,time,sys\ndef stop(*_):\n time.sleep(.2)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('ready',flush=True)\nwhile True: time.sleep(.1)\n").unwrap();
    // Executing a freshly written file can race another test's fork on Linux
    // (ETXTBSY). Launch the existing interpreter; the script is only read.
    let argv = vec![
        "ssh".into(),
        "python3".into(),
        script.to_string_lossy().into_owned(),
    ];
    let mut stream = NativeDuplex::prepare(DuplexSpec {
        argv: argv.clone(),
        executable: "/usr/bin/env".into(),
        env: HashMap::from([("PATH".into(), std::env::var("PATH").unwrap())]),
        input: vec![],
        timeout_ms: 1000,
    })
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let open = stream
        .answer(
            "capability.process.duplex.open",
            &json!({"argv":argv,"timeoutMs":1000}),
            deadline,
        )
        .await
        .unwrap();
    stream
        .answer(
            "capability.process.duplex.read",
            &json!({"handle":open["handle"],"length":64,"timeoutMs":1000}),
            deadline,
        )
        .await
        .unwrap();
    let closed = stream
        .answer(
            "capability.process.duplex.close",
            &json!({"handle":open["handle"]}),
            deadline,
        )
        .await
        .unwrap();
    assert_eq!(closed["code"], 0);
    assert!(closed["signal"].is_null());
    fs::remove_dir_all(root).unwrap();
}
