#![allow(clippy::unwrap_used)]
use super::*;
use std::io::Write;
#[tokio::test]
async fn all_sender_copies_remain_open_until_receipt_then_close() {
    if isolated("receipt_copy_tests::all_sender_copies_remain_open_until_receipt_then_close") {
        return;
    }
    use std::io::Read;
    let child = Command::new("/bin/sleep").arg("0.2").spawn().unwrap();
    let guard = Unhanded(Some(child));
    let slots = Arc::new(Semaphore::new(1));
    let permit = slots.clone().try_acquire_owned().unwrap();
    let (exit, remote_exit) = UnixStream::pair().unwrap();
    let (first, mut first_peer) = UnixStream::pair().unwrap();
    let (second, mut second_peer) = UnixStream::pair().unwrap();
    let (third, mut third_peer) = UnixStream::pair().unwrap();
    for peer in [&first_peer, &second_peer, &third_peer] {
        peer.set_nonblocking(true).unwrap();
    }
    let (parent, mut remote) = UnixStream::pair().unwrap();
    parent.set_nonblocking(true).unwrap();
    let parent = tokio::net::UnixStream::from_std(parent).unwrap();
    detach_handed_helper(guard, permit, exit).unwrap();
    let task = tokio::spawn(async move {
        finish_handoff_receipt(&parent, [first.into(), second.into(), third.into()], 5).await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    for peer in [&mut first_peer, &mut second_peer, &mut third_peer] {
        assert_eq!(
            peer.read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }
    remote.write_all(b"R").unwrap();
    task.await.unwrap().unwrap();
    for peer in [&mut first_peer, &mut second_peer, &mut third_peer] {
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    }
    drop(remote_exit);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), slots.acquire())
            .await
            .unwrap()
            .is_ok()
    );
}

pub(super) fn isolated(name: &str) -> bool {
    if std::env::var("PACER_RECEIPT_TEST_CHILD").as_deref() == Ok(name) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("serve::native_helper::{name}"),
            "--test-threads=1",
        ])
        .env("PACER_RECEIPT_TEST_CHILD", name)
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
            .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;"))
    );
    true
}
