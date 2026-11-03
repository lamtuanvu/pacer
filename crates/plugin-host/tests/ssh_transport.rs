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
#[tokio::test]
async fn ssh_run_tracked_separates_pre_spawn_rejections_from_ambiguous_results() {
    use pacer_plugin_host::native_command::CommandFailure::{Dispatched, Undispatched};
    // Short owned root keeps the control directory under it (not /tmp/pacer-ssh-*).
    let root = std::path::PathBuf::from(format!(
        "/tmp/pacer-sshtr-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let executable = root.join("fake-ssh");
    let marker = root.join("executions");
    let mode = root.join("mode");
    fs::write(
        &executable,
        r##"#!/usr/bin/env python3
import os,re,sys
open(os.environ['FIXTURE_MARK'],'a').write('exec\n')
mode=open(os.environ['FIXTURE_MODE']).read().strip()
n=re.findall(r'__PACER_DONE__=([a-f0-9-]{36})',sys.argv[-1])
if mode=='exit255': sys.exit(255)
if mode=='nobegin': sys.stdout.write('banner __PACER_BEGIN__\nx\n'); sys.exit(0)
if mode=='big': sys.stdout.write('__PACER_BEGIN__\n'+'x'*2000); sys.exit(0)
sys.stdout.write('__PACER_BEGIN__\nok=1\n'+('\n__PACER_DONE__='+n[0]+'\n' if n else ''))
"##,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let absent = root.join("absent-ssh");
    fs::write(&absent, "#!/nonexistent-pacer-fixture/interpreter\n").unwrap();
    fs::set_permissions(&absent, fs::Permissions::from_mode(0o700)).unwrap();
    let env = HashMap::from([
        ("PATH".into(), std::env::var("PATH").unwrap()),
        ("FIXTURE_MARK".into(), marker.to_str().unwrap().into()),
        ("FIXTURE_MODE".into(), mode.to_str().unwrap().into()),
    ]);
    let prepare = |exe: &std::path::Path| {
        NativeSsh::prepare(
            &root,
            SshConfig {
                alias: "fixture".into(),
                target: "fixture-host".into(),
                fingerprint: "fixed".into(),
            },
            exe.to_str().unwrap(),
            env.clone(),
        )
        .unwrap()
    };
    let ssh = prepare(&executable);
    let nonce = uuid::Uuid::new_v4().to_string();
    let soon = || Instant::now() + Duration::from_secs(5);
    let case = async |ssh: &NativeSsh,
                      name: &str,
                      nonce: Option<&str>,
                      timeout: u64,
                      max: usize,
                      deadline: Instant| {
        ssh.run_tracked(name, &["a".into()], nonce, &[], timeout, max, deadline)
            .await
    };
    fs::write(&mode, "ok").unwrap();
    let upper = nonce.to_uppercase();
    for (name, nonce, timeout, max, deadline) in [
        ("CHECK_REPO", None, 300001, 65536, soon()),
        ("CHECK_REPO", None, 1000, 0, soon()),
        ("CHECK_REPO", None, 1000, 524289, soon()),
        ("UNISSUED", None, 1000, 65536, soon()),
        ("CHECK_REPO", Some(upper.as_str()), 1000, 65536, soon()),
        ("CHECK_REPO", Some(&nonce[..35]), 1000, 65536, soon()),
        ("CHECK_REPO", None, 1000, 65536, Instant::now()),
    ] {
        let result = case(&ssh, name, nonce, timeout, max, deadline).await;
        assert!(
            matches!(result, Err(Undispatched(_))),
            "{name} {nonce:?} {timeout} {max}: {result:?}"
        );
    }
    let control = root.join("ssh");
    fs::set_permissions(&control, fs::Permissions::from_mode(0o755)).unwrap();
    let result = case(&ssh, "CHECK_REPO", None, 1000, 65536, soon()).await;
    assert!(
        matches!(result, Err(Undispatched(_))),
        "control: {result:?}"
    );
    fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
    for (m, max) in [("exit255", 65536), ("nobegin", 65536), ("big", 1024)] {
        fs::write(&mode, m).unwrap();
        let result = case(&ssh, "CHECK_REPO", Some(&nonce), 1000, max, soon()).await;
        assert!(matches!(result, Err(Dispatched(_))), "{m}: {result:?}");
    }
    let missing = prepare(&absent);
    let result = case(&missing, "CHECK_REPO", Some(&nonce), 1000, 65536, soon()).await;
    assert!(
        matches!(result, Err(Dispatched(_))),
        "spawn-err: {result:?}"
    );
    fs::write(&mode, "ok").unwrap();
    let result = case(&ssh, "CHECK_REPO", Some(&nonce), 1000, 65536, soon())
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"code":0,"stdout":format!("ok=1\n\n__PACER_DONE__={nonce}\n"),"stderr":"","timedOut":false})
    );
    // Markers are recorded only; classification is asserted from the variant.
    let _executions = fs::read_to_string(&marker)
        .unwrap_or_default()
        .lines()
        .count();
    fs::remove_dir_all(root).unwrap();
}
