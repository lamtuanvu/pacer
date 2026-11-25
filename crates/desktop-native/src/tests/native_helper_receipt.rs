#![allow(clippy::unwrap_used)]
use super::*;
use std::{future::Future, io::Write, task::Poll};
struct ExitGate(std::path::PathBuf);
impl Drop for ExitGate {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"exit");
    }
}

#[tokio::test]
async fn receipt_preserves_coalesced_next_request_and_rejects_ancillary() {
    if super::receipt_copy_tests::isolated(
        "receipt_tests::receipt_preserves_coalesced_next_request_and_rejects_ancillary",
    ) {
        return;
    }
    for ancillary in [false, true] {
        let (parent, mut remote) = UnixStream::pair().unwrap();
        parent.set_nonblocking(true).unwrap();
        let parent = tokio::net::UnixStream::from_std(parent).unwrap();
        if ancillary {
            let file = File::open("/dev/null").unwrap();
            send_rights(&remote, b"R", &[file.as_raw_fd()]).unwrap();
        } else {
            remote.write_all(&[b'R', 0, 0, 0, 1, b'x']).unwrap();
        }
        let mut byte = [0];
        let result = read_exact(&parent, &mut byte).await;
        if ancillary {
            assert!(result.is_err());
        } else {
            result.unwrap();
            assert_eq!(byte, *b"R");
            assert_eq!(read_request(&parent).await.unwrap(), Some(vec![b'x']));
        }
    }
}

#[tokio::test]
async fn positive_handoff_survives_receipt_refusal_timeout_abort_and_partial_send() {
    if super::receipt_copy_tests::isolated(
        "receipt_tests::positive_handoff_survives_receipt_refusal_timeout_abort_and_partial_send",
    ) {
        return;
    }
    for mode in [
        "eof",
        "malformed",
        "timeout",
        "abort",
        "partial",
        "prepoll-drop",
        "valid",
    ] {
        let home = tempfile::tempdir().unwrap();
        let completed = home.path().join("completed");
        let gate = ExitGate(home.path().join("exit"));
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "while [ ! -f \"$2\" ]; do sleep 0.01; done; printf complete > \"$1\"",
                "fixture",
            ])
            .arg(&completed)
            .arg(&gate.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(false);
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap().into_owned_fd().unwrap();
        let output = child.stdout.take().unwrap().into_owned_fd().unwrap();
        let guard = Unhanded(Some(child));
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        let (exit, remote_exit) = UnixStream::pair().unwrap();
        let originals = [input, output, remote_exit.into()];
        let (parent, mut remote) = UnixStream::pair().unwrap();
        parent.set_nonblocking(true).unwrap();
        let parent = tokio::net::UnixStream::from_std(parent).unwrap();
        let sent = if mode == "partial" { 1 } else { 5 };
        detach_handed_helper(guard, permit, exit).unwrap();
        let mut future =
            Box::pin(async move { finish_handoff_receipt(&parent, originals, sent).await });
        if mode == "prepoll-drop" {
            drop(future);
            assert!(slots.clone().try_acquire_owned().is_err());
            drop(gate);
            assert!(
                tokio::time::timeout(Duration::from_secs(2), slots.acquire())
                    .await
                    .unwrap()
                    .is_ok()
            );
            assert_eq!(std::fs::read(&completed).unwrap(), b"complete");
            continue;
        }
        // Establish the receipt wait explicitly before task cancellation.
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let task = tokio::spawn(future);
        assert!(slots.clone().try_acquire_owned().is_err());
        match mode {
            "eof" => drop(remote),
            "malformed" => remote.write_all(b"X").unwrap(),
            "valid" | "partial" => remote.write_all(b"R").unwrap(),
            "abort" => task.abort(),
            "timeout" => {
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), async {
                        while !task.is_finished() {
                            tokio::task::yield_now().await;
                        }
                    })
                    .await
                    .is_err()
                );
                task.abort();
            }
            _ => unreachable!(),
        }
        let result = task.await;
        if mode == "valid" {
            result.unwrap().unwrap();
        } else if mode == "abort" || mode == "timeout" {
            assert!(result.unwrap_err().is_cancelled());
        } else {
            assert!(result.unwrap().is_err());
        }
        // The reaper retains capacity even though this generation's receipt
        // task ended; no failure path may kill the already handed child.
        assert!(slots.clone().try_acquire_owned().is_err());
        drop(gate);
        let released = tokio::time::timeout(Duration::from_secs(2), slots.acquire())
            .await
            .unwrap_or_else(|error| panic!("{mode}: {error}; completed={}", completed.exists()));
        assert!(released.is_ok());
        assert_eq!(std::fs::read(&completed).unwrap(), b"complete");
    }
}
