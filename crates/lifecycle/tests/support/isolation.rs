//! Test isolation for deep inputs and the Bun canonical form (§2.1).
#![allow(dead_code, clippy::unwrap_used)]
use std::io::Write;
use std::process::{Command, Stdio};

/// Bun `JSON.stringify(JSON.parse(text))`, through stdin.
pub fn js_canonical(text: &str) -> String {
    let mut child = Command::new("bun")
        .args([
            "-e",
            "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))))",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

const CHILD: &str = "PACER_LIFECYCLE_ISOLATED_TEST";

/// Run `body` on a 2 MiB thread in a re-executed copy of this test binary, so a
/// stack overflow aborts only the child and is reported here as a failure.
pub fn isolated(name: &str, body: fn()) {
    if std::env::var(CHILD).as_deref() == Ok(name) {
        let result = std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(body)
            .unwrap()
            .join();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
        return;
    }
    let out = Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, name)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    let start = (stderr.len().saturating_sub(1500)..)
        .find(|&i| stderr.is_char_boundary(i))
        .unwrap_or(0);
    assert!(
        out.status.success(),
        "isolated child `{name}` failed ({:?}):\n{}",
        out.status,
        &stderr[start..]
    );
}
