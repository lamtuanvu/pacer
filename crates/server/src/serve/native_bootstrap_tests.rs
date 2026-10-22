#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

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
            &format!("serve::native_bootstrap::tests::{name}"),
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
