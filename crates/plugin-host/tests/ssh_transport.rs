#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{NativeSsh, SshConfig};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};
#[tokio::test]
async fn fixed_ssh_program_is_framed_and_text_never_becomes_program_source() {
    let root = std::env::temp_dir().join(format!("pacer-ssh-native-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let executable = root.join("ssh");
    fs::write(&executable,"#!/usr/bin/env python3\nimport sys\na=sys.argv\nassert a[1:5]==['-o','BatchMode=yes','-o','ConnectTimeout=10']\nassert a[-2]=='fixture-host'\nassert \"'a'\\\"'\\\"'$(touch forbidden)'\" in a[-1]\nprint('login banner')\nprint('__PACER_BEGIN__')\nprint('exists=1')\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let ssh = NativeSsh::prepare(
        &root,
        SshConfig {
            alias: "fixture".into(),
            target: "fixture-host".into(),
            fingerprint: "fixed".into(),
        },
        executable.to_str().unwrap(),
        HashMap::from([("PATH".into(), std::env::var("PATH").unwrap())]),
    )
    .unwrap();
    let result = ssh
        .run(
            "CHECK_REPO",
            &["a'$(touch forbidden)".into(), "check".into()],
            None,
            &[],
            1000,
            65536,
            Instant::now() + Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"code":0,"stdout":"exists=1\n","stderr":"","timedOut":false})
    );
    assert!(
        ssh.run(
            "UNISSUED",
            &[],
            None,
            &[],
            1000,
            65536,
            Instant::now() + Duration::from_secs(5)
        )
        .await
        .is_err()
    );
    assert!(!root.join("forbidden").exists());
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn exited_ssh_leader_cannot_strand_a_pipe_holding_descendant() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    use std::process::Command;
    let root = std::env::temp_dir().join(format!("pacer-ssh-descendant-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let executable = root.join("fixture-ssh");
    let pid_file = root.join("descendant");
    fs::write(&executable,r##"#!/usr/bin/env python3
import subprocess,os
p=subprocess.Popen(['python3','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])
open(os.environ['FIXTURE_PID'],'w').write(str(p.pid))
"##).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let ssh = NativeSsh::prepare(
        &root,
        SshConfig {
            alias: "fixture".into(),
            target: "fixture-host".into(),
            fingerprint: "fixed".into(),
        },
        executable.to_str().unwrap(),
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("FIXTURE_PID".into(), pid_file.to_str().unwrap().into()),
        ]),
    )
    .unwrap();
    let result = ssh
        .run(
            "PROBE",
            &[],
            None,
            &[],
            1000,
            65536,
            Instant::now() + Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(result["timedOut"], true);
    let pid = fs::read_to_string(&pid_file).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let state = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&state.stdout);
    let alive = state.chars().any(|c| c.is_alphabetic()) && !state.trim().starts_with('Z');
    if alive {
        kill(Pid::from_raw(pid.parse().unwrap()), Signal::SIGKILL).unwrap();
    }
    fs::remove_dir_all(root).unwrap();
    assert!(!alive, "owned descendant survived: {state}");
}
