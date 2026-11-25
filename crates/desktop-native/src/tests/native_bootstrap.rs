#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

// Byte-for-byte the frame the server's `core_secrets` module builds for its Core
// child (pacer-core-secrets/1, `internalToken`, `ownerKey`; `nativeConfigSyncKey`
// absent). Desktop-native must not depend on pacer-server, so the test fixture is
// produced here.
fn secrets_frame() -> Vec<u8> {
    let mut body = serde_json::Map::new();
    for (name, value) in [
        ("internalToken", Some("a".repeat(64))),
        ("ownerKey", Some("b".repeat(64))),
        ("nativeConfigSyncKey", None),
    ] {
        if let Some(value) = value {
            body.insert(name.into(), value.into());
        }
    }
    let body = serde_json::Value::Object(body).to_string();
    let mut frame = format!("pacer-core-secrets/1 {}\n", body.len()).into_bytes();
    frame.extend_from_slice(body.as_bytes());
    frame
}

// These tests prove process-local descriptor lifetime using peer EOF. Darwin
// cannot atomically CLOEXEC delivered rights. Other server tests spawn subprocesses and
// may inherit a temporary descriptor, invalidating EOF as a local-close proof.
// Keep every bootstrap FD-lifetime test in its own exact-test process, as the
// existing native-helper FD tests do; do not weaken assertions or add delays.
fn isolated(name: &str) -> bool {
    if std::env::var("PACER_BOOTSTRAP_FD_TEST_CHILD").as_deref() == Ok(name) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("native_bootstrap::tests::{name}"),
            "--test-threads=1",
        ])
        .env("PACER_BOOTSTRAP_FD_TEST_CHILD", name)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;")),
        "exact subprocess did not run one test: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    true
}

struct Dropped(Arc<AtomicBool>);
impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(1)
}
fn broker(activated: Arc<AtomicBool>, dropped: Arc<AtomicBool>) -> impl Future<Output = ()> + Send {
    let guard = Dropped(dropped);
    async move {
        let _guard = guard;
        activated.store(true, Ordering::SeqCst);
        std::future::pending::<()>().await;
    }
}
async fn settle() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}
async fn until(flag: &AtomicBool) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while !flag.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}
async fn joined(task: JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn bootstrap_does_not_activate_helper_before_ack() {
    if isolated("bootstrap_does_not_activate_helper_before_ack") {
        return;
    }
    let (parent, mut child) = UnixStream::pair().unwrap();
    let (helpers, remote) = UnixStream::pair().unwrap();
    let active = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let task = monitor(
        parent,
        remote,
        Vec::new(),
        broker(active.clone(), dropped.clone()),
        Arc::new(Notify::new()),
        deadline(),
    )
    .unwrap();
    settle().await;
    assert!(!active.load(Ordering::SeqCst));
    // Delayed ownership receipt must still see a live endpoint, not EOF.
    helpers.set_nonblocking(true).unwrap();
    let mut byte = [0];
    assert_eq!(
        (&helpers).read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    child.write_all(b"A").unwrap();
    until(&active).await;
    assert_eq!((&helpers).read(&mut byte).unwrap(), 0); // sender original dropped after ACK
    drop(child);
    joined(task).await;
    until(&dropped).await;
}

#[tokio::test]
async fn coalesced_ack_shutdown_is_accepted_but_other_controls_are_not() {
    if isolated("coalesced_ack_shutdown_is_accepted_but_other_controls_are_not") {
        return;
    }
    for bytes in [b"AS", b"AX", b"AA"] {
        let (parent, mut child) = UnixStream::pair().unwrap();
        let (_helpers, remote) = UnixStream::pair().unwrap();
        let stop = Arc::new(Notify::new());
        let task = monitor(
            parent,
            remote,
            Vec::new(),
            std::future::pending(),
            stop.clone(),
            deadline(),
        )
        .unwrap();
        child.write_all(bytes).unwrap();
        joined(task).await;
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(10), stop.notified())
                .await
                .is_ok(),
            bytes == b"AS"
        );
        let mut byte = [0];
        assert_eq!(child.read(&mut byte).unwrap(), 0);
    }
}

#[tokio::test]
async fn malformed_eof_timeout_and_abort_drop_unstarted_broker_and_retained_remote() {
    if isolated("malformed_eof_timeout_and_abort_drop_unstarted_broker_and_retained_remote") {
        return;
    }
    for failure in ["malformed", "eof", "timeout", "abort"] {
        let (parent, mut child) = UnixStream::pair().unwrap();
        let (mut helpers, remote) = UnixStream::pair().unwrap();
        let active = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(Notify::new());
        let task = monitor(
            parent,
            remote,
            Vec::new(),
            broker(active.clone(), dropped.clone()),
            stop.clone(),
            Instant::now() + Duration::from_millis(50),
        )
        .unwrap();
        match failure {
            "malformed" => child.write_all(b"X").unwrap(),
            "eof" => child.shutdown(std::net::Shutdown::Write).unwrap(),
            "abort" => {
                task.abort();
            }
            _ => {}
        }
        if failure == "abort" {
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            joined(task).await;
        }
        assert!(!active.load(Ordering::SeqCst));
        assert!(dropped.load(Ordering::SeqCst));
        let mut byte = [0];
        assert_eq!(helpers.read(&mut byte).unwrap(), 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), stop.notified())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn delayed_two_right_receipt_survives_and_core_death_is_visible_after_ack() {
    if isolated("delayed_two_right_receipt_survives_and_core_death_is_visible_after_ack") {
        return;
    }
    use nix::sys::socket::{ControlMessageOwned, MsgFlags, UnixAddr, recv, recvmsg};
    use tokio::io::AsyncReadExt;
    let (parent, mut child) = UnixStream::pair().unwrap();
    let (listener, _listener_peer) = UnixStream::pair().unwrap();
    let (helpers, remote) = UnixStream::pair().unwrap();
    send(&parent, &listener, &remote).unwrap();
    let ended = Arc::new(AtomicBool::new(false));
    let observed = ended.clone();
    let task = monitor(
        parent,
        remote,
        Vec::new(),
        async move {
            helpers.set_nonblocking(true).unwrap();
            let mut helpers = tokio::net::UnixStream::from_std(helpers).unwrap();
            let mut byte = [0];
            assert_eq!(helpers.read(&mut byte).await.unwrap(), 0);
            observed.store(true, Ordering::SeqCst);
        },
        Arc::new(Notify::new()),
        deadline(),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut marker = [0];
    let mut vectors = [io::IoSliceMut::new(&mut marker)];
    let mut storage = nix::cmsg_space!([i32; 2]);
    let message = recvmsg::<UnixAddr>(
        child.as_raw_fd(),
        &mut vectors,
        Some(&mut storage),
        MsgFlags::empty(),
    )
    .unwrap();
    assert_eq!(message.bytes, 1);
    let rights: Vec<_> = message
        .cmsgs()
        .unwrap()
        .flat_map(|c| match c {
            ControlMessageOwned::ScmRights(fds) => fds,
            _ => vec![],
        })
        .collect();
    assert_eq!(marker, *b"B");
    assert_eq!(rights.len(), 2);
    let mut byte = [0];
    assert_eq!(
        recv(rights[1], &mut byte, MsgFlags::MSG_DONTWAIT).unwrap_err(),
        nix::errno::Errno::EAGAIN
    );
    child.write_all(b"A").unwrap();
    settle().await;
    assert!(!ended.load(Ordering::SeqCst));
    // Root must no longer keep a duplicate of Core's endpoint after receipt.
    for fd in rights {
        nix::unistd::close(fd).unwrap();
    }
    until(&ended).await;
    drop(child);
    joined(task).await;
}

#[tokio::test]
async fn secrets_frame_follows_only_the_ack_and_survives_one_byte_receipt() {
    if isolated("secrets_frame_follows_only_the_ack_and_survives_one_byte_receipt") {
        return;
    }
    use nix::sys::socket::{ControlMessageOwned, MsgFlags, UnixAddr, recv, recvmsg};
    let frame = secrets_frame();
    for ack in [b'A', b'X', 0] {
        let (parent, mut child) = UnixStream::pair().unwrap();
        let (listener, _listener_peer) = UnixStream::pair().unwrap();
        let (_helpers, remote) = UnixStream::pair().unwrap();
        send(&parent, &listener, &remote).unwrap();
        let task = monitor(
            parent,
            remote,
            frame.clone(),
            std::future::pending(),
            Arc::new(Notify::new()),
            deadline(),
        )
        .unwrap();
        settle().await;
        // Core's shim receives `B` into a one-byte buffer, as `pacer_receive_parent_channels` does.
        let mut marker = [0];
        let mut vectors = [io::IoSliceMut::new(&mut marker)];
        let mut storage = nix::cmsg_space!([i32; 2]);
        let message = recvmsg::<UnixAddr>(
            child.as_raw_fd(),
            &mut vectors,
            Some(&mut storage),
            MsgFlags::empty(),
        )
        .unwrap();
        assert_eq!(message.bytes, 1);
        for control in message.cmsgs().unwrap() {
            if let ControlMessageOwned::ScmRights(fds) = control {
                for fd in fds {
                    nix::unistd::close(fd).unwrap();
                }
            }
        }
        assert_eq!(marker, *b"B");
        // Nothing follows `B` until Core has authenticated the channel and acknowledged.
        let mut byte = [0];
        assert_eq!(
            recv(child.as_raw_fd(), &mut byte, MsgFlags::MSG_DONTWAIT).unwrap_err(),
            nix::errno::Errno::EAGAIN
        );
        match ack {
            0 => child.shutdown(std::net::Shutdown::Write).unwrap(),
            ack => child.write_all(&[ack]).unwrap(),
        }
        if ack == b'A' {
            use tokio::io::AsyncReadExt;
            child.set_nonblocking(true).unwrap();
            let mut child = tokio::net::UnixStream::from_std(child).unwrap();
            let mut received = vec![0; frame.len()];
            tokio::time::timeout(Duration::from_secs(2), child.read_exact(&mut received))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(received, frame);
            drop(child);
            joined(task).await;
        } else {
            joined(task).await;
            let mut received = Vec::new();
            child.read_to_end(&mut received).unwrap();
            assert!(received.is_empty(), "no acknowledgement, no frame");
        }
    }
}

#[tokio::test]
async fn ancillary_rights_are_rejected_and_all_100_or_254_delivered_fds_are_closed() {
    if isolated("ancillary_rights_are_rejected_and_all_100_or_254_delivered_fds_are_closed") {
        return;
    }
    use nix::sys::socket::{ControlMessage, MsgFlags, UnixAddr, sendmsg};
    for count in [100, 254] {
        for phase in ["ack", "shutdown"] {
            let (parent, mut child) = UnixStream::pair().unwrap();
            let (_helpers, remote) = UnixStream::pair().unwrap();
            let (mut leak_probe, unexpected) = UnixStream::pair().unwrap();
            let active = Arc::new(AtomicBool::new(false));
            let dropped = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(Notify::new());
            let task = monitor(
                parent,
                remote,
                Vec::new(),
                broker(active.clone(), dropped.clone()),
                stop.clone(),
                deadline(),
            )
            .unwrap();
            if phase == "shutdown" {
                child.write_all(b"A").unwrap();
                until(&active).await;
            }
            let descriptors = vec![unexpected.as_raw_fd(); count];
            let byte = if phase == "ack" { b"A" } else { b"S" };
            assert_eq!(
                sendmsg::<UnixAddr>(
                    child.as_raw_fd(),
                    &[io::IoSlice::new(byte)],
                    &[ControlMessage::ScmRights(&descriptors)],
                    MsgFlags::empty(),
                    None
                )
                .unwrap(),
                1
            );
            joined(task).await;
            until(&dropped).await;
            assert_eq!(active.load(Ordering::SeqCst), phase == "shutdown");
            assert!(dropped.load(Ordering::SeqCst));
            assert!(
                tokio::time::timeout(Duration::from_millis(10), stop.notified())
                    .await
                    .is_err()
            );
            // A leaked delivered duplicate would keep this opposite end alive.
            drop(unexpected);
            leak_probe.set_nonblocking(true).unwrap();
            let mut byte = [0];
            assert_eq!(leak_probe.read(&mut byte).unwrap(), 0);
        }
    }
}

#[tokio::test]
async fn expired_deadline_rejects_even_buffered_ack_and_abort_retires_active_broker() {
    if isolated("expired_deadline_rejects_even_buffered_ack_and_abort_retires_active_broker") {
        return;
    }
    for expired in [true, false] {
        let (parent, mut child) = UnixStream::pair().unwrap();
        let (_helpers, remote) = UnixStream::pair().unwrap();
        let active = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        child.write_all(b"A").unwrap();
        let deadline = if expired {
            Instant::now() - Duration::from_millis(1)
        } else {
            deadline()
        };
        let task = monitor(
            parent,
            remote,
            Vec::new(),
            broker(active.clone(), dropped.clone()),
            Arc::new(Notify::new()),
            deadline,
        )
        .unwrap();
        if expired {
            joined(task).await;
        } else {
            until(&active).await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        until(&dropped).await;
        assert_eq!(active.load(Ordering::SeqCst), !expired);
        let mut byte = [0];
        assert_eq!(child.read(&mut byte).unwrap(), 0);
    }
}
