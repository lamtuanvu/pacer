#![allow(clippy::unwrap_used)]
use pacer_foundation::{
    Ctx,
    fsutil::{read_json, write_json_atomic},
    lock::{LockOptions, with_lock},
};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

#[test]
fn bun_and_rust_share_one_lock() {
    let bun = std::env::var_os("PACER_TEST_BUN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // The executor's pinned Bun lives in the reference checkout's tools directory.
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("orca/workspaces/pacer/pinfish/.work/tools/bun-1.4.2/bun")
        });
    let version = match Command::new(&bun).arg("--version").output() {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "SKIP: Bun not found at {}; set PACER_TEST_BUN to run cross-runtime contention",
                bun.display()
            );
            return;
        }
        Err(e) => panic!("cannot execute Bun: {e}"),
    };
    assert!(version.status.success(), "Bun --version failed");
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        0.0,
    );
    let counter = dir.path().join("counter.json");
    write_json_atomic(&counter, &0_u64).unwrap();
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/lock-contend.ts");
    // Hold the shared lock during spawn, forcing Bun to wait for the Rust writer.
    let mut child = with_lock(&ctx, "contend", LockOptions::default(), || {
        let child = Command::new(bun)
            .arg(script)
            .arg(dir.path())
            .arg("200")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        child
    })
    .unwrap();
    for _ in 0..200 {
        with_lock(&ctx, "contend", LockOptions::default(), || {
            let value: u64 = read_json(&counter).unwrap();
            std::thread::sleep(Duration::from_millis(1));
            write_json_atomic(&counter, &(value + 1)).unwrap();
        })
        .unwrap();
    }
    // Keep a bounded wait so a broken protocol cannot hang the test indefinitely.
    let start = std::time::Instant::now();
    while child.try_wait().unwrap().is_none() {
        if start.elapsed() > Duration::from_secs(30) {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("Bun contention writer timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(read_json::<u64>(&counter), Some(400));
}
