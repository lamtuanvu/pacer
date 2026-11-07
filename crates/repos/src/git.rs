use super::mark_unreachable;
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(2);

/// `boundedGitRead(ctx.run, ["git", "-C", dir, ...args], 2000)` with the service environment:
/// the exit code and stdout, or `None` (and `dir` marked unreachable) when the read did not
/// finish in two seconds. A spawn failure exits 127, as `execProcess` reports it.
pub(crate) fn git_read(dir: &str, args: &[&str]) -> Option<(i32, String)> {
    git_read_within(dir, args, TIMEOUT)
}

/// `git_read` with another deadline.
pub fn git_read_within(dir: &str, args: &[&str], timeout: Duration) -> Option<(i32, String)> {
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Some((127, String::new()));
    };
    let timed_out = |mut child: std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
        mark_unreachable(dir);
        None
    };
    let Some(mut stdout) = child.stdout.take() else {
        return timed_out(child);
    };
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let deadline = Instant::now() + timeout;
    let Ok(bytes) = rx.recv_timeout(timeout) else {
        return timed_out(child);
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Some((
                    status.code().unwrap_or(1),
                    String::from_utf8_lossy(&bytes).into_owned(),
                ));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
            _ => return timed_out(child),
        }
    }
}
