#![allow(clippy::unwrap_used)]
use base64::Engine;
use pacer_plugin_host::{
    CommandResource, CredentialBindings, NativeProcess, NativeWrite, SpawnCapture, SpawnMode,
    WriteResource,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("pacer-spawn-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(fs::canonicalize(p).unwrap())
    }
    fn child(&self, body: &str) -> PathBuf {
        let p = self.0.join("child");
        fs::write(&p, format!("#!/usr/bin/env python3\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        p
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn owner(command: CommandResource, path: &Path) -> NativeProcess {
    NativeProcess::prepare(
        std::slice::from_ref(&command),
        &HashMap::from([(command.argv[0].clone(), path.to_string_lossy().into_owned())]),
        &HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("REMOTE_MARKER".into(), "captured".into()),
        ]),
    )
    .unwrap()
}
fn secret_command() -> CommandResource {
    CommandResource {
        argv: vec!["tool".into()],
        timeout_ms: 2000,
        env: Some(HashMap::from([("PLAIN".into(), "captured".into())])),
        secret_env: Some(HashMap::from([("KEY".into(), "endpoint:owned".into())])),
        ..Default::default()
    }
}
#[tokio::test]
async fn empty_context_is_distinct_from_omitted_and_secret_references_match_exactly() {
    let command = CommandResource {
        argv: vec!["env".into()],
        timeout_ms: 1000,
        env: Some(HashMap::new()),
        ..Default::default()
    };
    let mut process = owner(command, Path::new("/usr/bin/env"));
    assert!(
        process
            .spawn(&json!({"argv":["env"],"timeoutMs":1000}), deadline())
            .await
            .is_err()
    );
    assert_eq!(
        process
            .spawn(
                &json!({"argv":["env"],"timeoutMs":1000,"env":{}}),
                deadline()
            )
            .await
            .unwrap()["stdout"],
        ""
    );
    let mut bindings = CredentialBindings::default();
    bindings
        .bind_value("endpoint:owned", Some("synthetic-secret".into()))
        .unwrap();
    let mut process = owner(secret_command(), Path::new("/usr/bin/env")).with_credentials(bindings);
    for env in [
        json!({"PLAIN":"captured","KEY":"synthetic-secret"}),
        json!({"PLAIN":"captured","KEY":{"secretRef":"endpoint:foreign"}}),
        json!({"PLAIN":"captured","KEY":{"secretRef":"endpoint:owned","extra":1}}),
    ] {
        assert!(
            process
                .spawn(
                    &json!({"argv":["tool"],"timeoutMs":1000,"env":env}),
                    deadline()
                )
                .await
                .is_err()
        );
    }
    assert!(process.spawn(&json!({"argv":["tool"],"timeoutMs":1000,"env":{"PLAIN":"captured","KEY":{"secretRef":"endpoint:owned"}}}),deadline()).await.is_err(),"credential reflection must not reach output handles");
}
#[tokio::test]
async fn secret_fragments_are_suppressed_and_never_captured() {
    let f = Sandbox::new();
    let child = f.child(
        "import os,sys\nsys.stdout.write(os.environ['KEY'][:4])\nsys.stderr.write('private')",
    );
    let mut command = secret_command();
    command.env = Some(HashMap::from([(
        "PATH".into(),
        std::env::var("PATH").unwrap(),
    )]));
    command.suppress_output = true;
    let mut bindings = CredentialBindings::default();
    bindings
        .bind_value("endpoint:owned", Some("synthetic-secret".into()))
        .unwrap();
    let env = json!({"PATH":std::env::var("PATH").unwrap(),"KEY":{"secretRef":"endpoint:owned"}});
    let result = owner(command.clone(), &child)
        .with_credentials(bindings)
        .spawn(
            &json!({"argv":["tool"],"timeoutMs":1000,"env":env}),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"code":0,"stdout":"","stderr":"","timedOut":false})
    );
    command.capture = Some(SpawnCapture {
        stdout: "/unused/out".into(),
        stderr: "/unused/err".into(),
    });
    assert!(NativeProcess::prepare(&[command], &HashMap::new(), &HashMap::new()).is_err());
}
#[tokio::test]
async fn capture_preserves_binary_bytes_and_refuses_replaced_targets() {
    let f = Sandbox::new();
    let child =
        f.child("import sys\nsys.stdout.buffer.write(bytes([255,0,65]))\nsys.stderr.write('err')");
    let out = f.0.join("out");
    let err = f.0.join("err");
    let paths = SpawnCapture {
        stdout: out.to_string_lossy().into_owned(),
        stderr: err.to_string_lossy().into_owned(),
    };
    let writes = [&paths.stdout, &paths.stderr].map(|p| WriteResource {
        path: p.clone(),
        kind: "file".into(),
        operations: vec!["write".into()],
    });
    let command = CommandResource {
        argv: vec!["tool".into()],
        timeout_ms: 1000,
        capture: Some(paths),
        ..Default::default()
    };
    let capture = NativeWrite::prepare(&f.0, &writes).unwrap();
    let mut process = owner(command.clone(), &child).with_capture(capture);
    let params = json!({"argv":["tool"],"timeoutMs":1000});
    let r = process.spawn(&params, deadline()).await.unwrap();
    assert_eq!(r["stdout"], "�\0A");
    assert_eq!(fs::read(&out).unwrap(), [255, 0, 65]);
    assert_eq!(
        fs::metadata(&out).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::remove_file(&out).unwrap();
    symlink(&err, &out).unwrap();
    assert!(process.spawn(&params, deadline()).await.is_err());
    assert_eq!(fs::read(&err).unwrap(), b"err");
}
#[tokio::test]
async fn remote_input_modes_validate_hash_limits_and_are_one_use_per_mode() {
    let f = Sandbox::new();
    let child=f.child("import sys,os\nsys.stdout.buffer.write(sys.stdin.buffer.read())\nsys.stderr.write(os.environ['REMOTE_MARKER'])");
    for mode in [
        SpawnMode::PrepareBundle,
        SpawnMode::StartInput,
        SpawnMode::BinaryUpload,
    ] {
        let bytes = b"binary\0input\xff".to_vec();
        let command = CommandResource {
            argv: vec!["ssh".into()],
            timeout_ms: 1000,
            mode: Some(mode),
            input: Some(bytes.clone()),
            input_sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
            ..Default::default()
        };
        let mut process = owner(command.clone(), &child);
        let params = json!({"argv":["ssh"],"timeoutMs":1000});
        let r = process.spawn(&params, deadline()).await.unwrap();
        assert_eq!(r["stderr"], "captured");
        assert_eq!(
            r["stdout"],
            if mode == SpawnMode::BinaryUpload {
                json!(base64::engine::general_purpose::STANDARD.encode(&bytes))
            } else {
                json!("binary\0input�")
            }
        );
        assert!(process.spawn(&params, deadline()).await.is_err());
        let mut bad = command.clone();
        bad.input_sha256 = Some("0".repeat(64));
        assert!(NativeProcess::prepare(&[bad], &HashMap::new(), &HashMap::new()).is_err());
        let mut bad = command.clone();
        bad.env = Some(HashMap::new());
        assert!(NativeProcess::prepare(&[bad], &HashMap::new(), &HashMap::new()).is_err());
        let mut bad = command;
        bad.argv[0] = "tool".into();
        assert!(NativeProcess::prepare(&[bad], &HashMap::new(), &HashMap::new()).is_err());
    }
}
#[tokio::test]
async fn codex_live_keeps_input_open_until_response_id_two_and_consumes_once() {
    let f = Sandbox::new();
    let child=f.child("import sys,json\nfor _ in range(3): json.loads(sys.stdin.readline())\nprint('diagnostic',flush=True)\nprint(json.dumps({'id':1,'result':{}}),flush=True)\nprint(json.dumps({'id':2,'result':{'ok':True}}),flush=True)\nassert sys.stdin.read()==''");
    let command = CommandResource {
        argv: ["codex", "-s", "read-only", "-a", "never", "app-server"]
            .map(str::to_owned)
            .to_vec(),
        timeout_ms: 1000,
        mode: Some(SpawnMode::CodexLive),
        env: Some(HashMap::from([
            ("CODEX_HOME".into(), f.0.to_string_lossy().into_owned()),
            ("PATH".into(), std::env::var("PATH").unwrap()),
        ])),
        ..Default::default()
    };
    let mut process = NativeProcess::prepare_account(
        std::slice::from_ref(&command),
        &HashMap::from([("codex".into(), child.to_string_lossy().into_owned())]),
        &HashMap::new(),
        Some(f.0.to_str().unwrap()),
    )
    .unwrap();
    let params = json!({"argv":command.argv,"timeoutMs":1000});
    let r = process.spawn(&params, deadline()).await.unwrap();
    assert_eq!(r["code"], 0);
    assert_eq!(r["timedOut"], false);
    assert!(process.spawn(&params, deadline()).await.is_err());
    assert!(NativeProcess::prepare(&[command], &HashMap::new(), &HashMap::new()).is_err());
}
#[tokio::test]
async fn cleanup_uncertainty_sticks_and_utf16_argv_bounds_match_js() {
    let mut command = CommandResource {
        argv: vec!["echo".into(), "😀".repeat(2048)],
        timeout_ms: 1000,
        ..Default::default()
    };
    assert!(
        NativeProcess::prepare(
            std::slice::from_ref(&command),
            &HashMap::new(),
            &HashMap::new()
        )
        .is_ok()
    );
    command.argv[1].push('x');
    assert!(NativeProcess::prepare(&[command], &HashMap::new(), &HashMap::new()).is_err());
    let command = CommandResource {
        argv: vec!["sh".into(), "-c".into(), "sleep 0.5 & exit 0".into()],
        timeout_ms: 1000,
        ..Default::default()
    };
    let mut process = owner(command.clone(), Path::new("/bin/sh"));
    let params = json!({"argv":command.argv,"timeoutMs":1000});
    assert!(process.spawn(&params, deadline()).await.is_err());
    assert!(process.spawn(&params, deadline()).await.is_err());
}
#[tokio::test]
async fn credential_reflection_compares_raw_bytes_before_utf8_replacement() {
    let f = Sandbox::new();
    let child = f.child("import sys\nsys.stdout.buffer.write(b'\\xff')");
    let mut command = secret_command();
    command.env = Some(HashMap::from([(
        "PATH".into(),
        std::env::var("PATH").unwrap(),
    )]));
    let mut bindings = CredentialBindings::default();
    bindings
        .bind_value("endpoint:owned", Some("�".into()))
        .unwrap();
    let env = json!({"PATH":std::env::var("PATH").unwrap(),"KEY":{"secretRef":"endpoint:owned"}});
    let result = owner(command, &child)
        .with_credentials(bindings)
        .spawn(
            &json!({"argv":["tool"],"timeoutMs":1000,"env":env}),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(result["stdout"], "�");
}
