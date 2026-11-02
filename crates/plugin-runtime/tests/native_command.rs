#![allow(clippy::unwrap_used)]
use pacer_plugin_runtime::{BrokerError, native_command, native_process::Image};
use std::{
    collections::HashMap,
    process::Command,
    time::{Duration, Instant},
};
fn python() -> Image {
    let result = Command::new("python3")
        .args([
            "-c",
            "import os,sys;print(os.path.realpath(sys.executable))",
        ])
        .output()
        .unwrap();
    assert!(result.status.success());
    Image::pin(String::from_utf8(result.stdout).unwrap().trim(), true).unwrap()
}
async fn run(
    script: &str,
    input: &[u8],
    timeout: u64,
    max: usize,
) -> Result<native_command::Output, BrokerError> {
    native_command::run(
        &python(),
        &["-c".into(), script.into()],
        &HashMap::new(),
        input,
        timeout,
        max,
        Instant::now() + Duration::from_secs(10),
    )
    .await
}
#[tokio::test]
async fn successful_early_stdin_close_waits_for_complete_status_and_output() {
    let input = vec![17; 2 * 1024 * 1024];
    let out = run("import os,time;os.read(0,1);os.close(0);time.sleep(0.05);os.write(1,b'accepted');os.write(2,b'diagnostic')", &input, 2000, 1024).await.unwrap();
    assert_eq!(out.code, 0);
    assert!(!out.timed_out);
    assert_eq!(out.stdout, b"accepted");
    assert_eq!(out.stderr, b"diagnostic");
}
#[tokio::test]
async fn early_stdin_close_does_not_hide_failed_exit_output_bound_or_timeout() {
    let input = vec![17; 2 * 1024 * 1024];
    assert!(
        run(
            "import os,time;os.close(0);time.sleep(0.05);os._exit(7)",
            &input,
            2000,
            1024
        )
        .await
        .is_err()
    );
    assert!(matches!(
        run(
            "import os,time;os.close(0);time.sleep(0.05);os.write(1,b'x'*4096)",
            &input,
            2000,
            128
        )
        .await,
        Err(BrokerError::Invalid(_))
    ));
    let out = run(
        "import os,time;os.close(0);time.sleep(10)",
        &input,
        100,
        1024,
    )
    .await
    .unwrap();
    assert!(out.timed_out);
    assert_ne!(out.code, 0);
}
#[tokio::test]
async fn full_input_and_nonzero_child_status_remain_observable() {
    let input = vec![17; 2 * 1024 * 1024];
    let out = run(
        "import sys;data=sys.stdin.buffer.read();print(len(data));sys.exit(7)",
        &input,
        2000,
        1024,
    )
    .await
    .unwrap();
    assert_eq!(out.code, 7);
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        input.len().to_string()
    );
    assert!(!out.timed_out);
    assert!(run("", &[], 0, 1024).await.is_err());
    assert!(run("\0", &input, 2000, 1024).await.is_err());
}

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pacer-command-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
async fn ready_pid(path: &std::path::Path) -> String {
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && text.parse::<u32>().is_ok_and(|pid| pid > 0)
        {
            return text;
        }
        assert!(Instant::now() < until, "child did not publish its PID");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
fn running(pid: &str) -> bool {
    let result = Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&result.stdout);
    !state.trim().is_empty() && !state.trim().starts_with('Z')
}
async fn stopped(pid: &str) {
    let until = Instant::now() + Duration::from_secs(2);
    while running(pid) && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!running(pid), "owned descendant {pid} survived cleanup");
}
#[tokio::test]
async fn pending_stdin_does_not_reap_leader_before_owned_descendant_cleanup() {
    let fixture = Fixture::new();
    let pidfile = fixture.0.join("pid");
    let image = python();
    let args = vec!["-c".into(), "import os,sys,time\nchild=os.fork()\nif child: os._exit(0)\nos.close(1);os.close(2)\nopen(sys.argv[1],'w').write(str(os.getpid()))\ntime.sleep(10)".into(), pidfile.to_str().unwrap().into()];
    let output = native_command::run(
        &image,
        &args,
        &HashMap::new(),
        &vec![17; 2 * 1024 * 1024],
        300,
        1024,
        Instant::now() + Duration::from_secs(3),
    )
    .await
    .unwrap();
    assert!(output.timed_out);
    let pid = ready_pid(&pidfile).await;
    // On failure, clean only this test's known child before reporting the defect.
    let alive = running(&pid);
    if alive {
        let _ = Command::new("kill").args(["-KILL", &pid]).status();
    }
    assert!(!alive, "stdin holder survived after leader was reaped");
}
#[tokio::test]
async fn dropping_command_future_cleans_owned_leader_and_descendant() {
    let fixture = Fixture::new();
    let image = python();
    let root = fixture.0.clone();
    let task = tokio::spawn(async move {
        let args = vec!["-c".into(), "import os,sys,time\nchild=os.fork()\nname='parent' if child else 'child'\nopen(sys.argv[1]+'/'+name,'w').write(str(os.getpid()))\ntime.sleep(10)".into(), root.to_str().unwrap().into()];
        native_command::run(
            &image,
            &args,
            &HashMap::new(),
            &[],
            10000,
            1024,
            Instant::now() + Duration::from_secs(10),
        )
        .await
    });
    let parent = ready_pid(&fixture.0.join("parent")).await;
    let child = ready_pid(&fixture.0.join("child")).await;
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    stopped(&parent).await;
    stopped(&child).await;
}
#[tokio::test]
async fn successful_early_close_still_rechecks_the_pinned_executable_identity() {
    let fixture = Fixture::new();
    let logical = fixture.0.join("python");
    std::os::unix::fs::symlink(python().canonical, &logical).unwrap();
    let image = Image::pin(logical.to_str().unwrap(), true).unwrap();
    let args = vec![
        "-c".into(),
        "import os,sys;os.close(0);os.unlink(sys.argv[1]);os.symlink('/bin/cat',sys.argv[1])"
            .into(),
        logical.to_str().unwrap().into(),
    ];
    assert!(
        native_command::run(
            &image,
            &args,
            &HashMap::new(),
            &vec![17; 2 * 1024 * 1024],
            2000,
            1024,
            Instant::now() + Duration::from_secs(3)
        )
        .await
        .is_err()
    );
}
