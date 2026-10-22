#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn request_accepts_only_fixed_private_helper_coordinates_and_exact_schema() {
    let home = Path::new("/tmp/helper-home");
    let path = format!(
        "{}/desktop-updates/native/{}/12345678-1234-1234-1234-123456789abc/pacer-update-helper",
        home.display(),
        "a".repeat(64)
    );
    let valid = serde_json::json!({"schema":1,"path":path,"sha256":"b".repeat(64),"version":"0.2.3","startedAtMs":123});
    assert!(request(&serde_json::to_vec(&valid).unwrap(), home).is_ok());
    for stamp in [
        serde_json::Value::Null,
        serde_json::json!(-1),
        serde_json::json!(1.5),
        serde_json::json!(9007199254740992u64),
        serde_json::json!("123"),
    ] {
        let mut bad = valid.clone();
        bad["startedAtMs"] = stamp;
        assert!(request(&serde_json::to_vec(&bad).unwrap(), home).is_err());
    }
    let mut missing = valid.clone();
    missing.as_object_mut().unwrap().remove("startedAtMs");
    assert!(request(&serde_json::to_vec(&missing).unwrap(), home).is_err());
    for replacement in [
        "/bin/sh",
        "/tmp/helper-home/../bin/pacer-update-helper",
        "/tmp/helper-home/desktop-updates/native/other/pacer-update-helper",
    ] {
        let mut bad = valid.clone();
        bad["path"] = replacement.into();
        assert!(request(&serde_json::to_vec(&bad).unwrap(), home).is_err());
    }
    let mut unknown = valid.clone();
    unknown["args"] = serde_json::json!(["--other"]);
    assert!(request(&serde_json::to_vec(&unknown).unwrap(), home).is_err());
}
#[test]
fn code_image_metadata_rejects_ambiguous_hashes_and_nonhex() {
    assert_eq!(
        cdhash(b"Executable=/tmp/helper\nCDHash=0123456789abcdef0123456789abcdef01234567\n")
            .unwrap(),
        "0123456789abcdef0123456789abcdef01234567"
    );
    for bytes in [b"CDHash=bad\n".as_slice(), b"CDHash=0123456789abcdef0123456789abcdef01234567\nCDHash=0123456789abcdef0123456789abcdef01234567\n".as_slice(), b"no hash".as_slice()] { assert!(cdhash(bytes).is_err()); }
}
fn command_asset() -> (tempfile::TempDir, Request) {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let parent = root
        .path()
        .join("desktop-updates/native")
        .join("a".repeat(64))
        .join("commands/12345678-1234-1234-1234-123456789abc");
    std::fs::create_dir_all(&parent).unwrap();
    let mut directory = parent.as_path();
    loop {
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        if directory == root.path() {
            break;
        }
        directory = directory.parent().unwrap();
    }
    let path = parent.join("pacer-update-helper");
    std::fs::write(&path, b"fixed asset").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let request = Request {
        started_at_ms: 0,
        path,
        sha256: hex::encode(Sha256::digest(b"fixed asset")),
        version: "0.2.3".into(),
    };
    (root, request)
}
#[test]
fn held_helper_refuses_changed_bytes_permissions_hash_and_redirects() {
    use std::os::unix::fs::PermissionsExt;
    let (root, mut request) = command_asset();
    let asset = Asset::verify(&request, root.path()).unwrap();
    asset.recheck().unwrap();
    std::fs::write(&request.path, b"replacement").unwrap();
    assert!(asset.recheck().is_err());
    assert!(Asset::verify(&request, root.path()).is_err());
    request.sha256 = hex::encode(Sha256::digest(b"replacement"));
    std::fs::set_permissions(&request.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(Asset::verify(&request, root.path()).is_err());
    let alias = request.path.with_extension("link");
    std::fs::rename(&request.path, &alias).unwrap();
    std::os::unix::fs::symlink(&alias, &request.path).unwrap();
    assert!(Asset::verify(&request, root.path()).is_err());
}
#[tokio::test]
async fn request_stream_rejects_oversize_and_incoming_descriptor_authority() {
    use std::io::Write;
    let (parent, mut remote) = UnixStream::pair().unwrap();
    parent.set_nonblocking(true).unwrap();
    let parent = tokio::net::UnixStream::from_std(parent).unwrap();
    remote.write_all(&8193u32.to_be_bytes()).unwrap();
    assert!(read_request(&parent).await.is_err());
    let (parent, remote) = UnixStream::pair().unwrap();
    parent.set_nonblocking(true).unwrap();
    let parent = tokio::net::UnixStream::from_std(parent).unwrap();
    let file = File::open("/dev/null").unwrap();
    send_rights(&remote, &[0, 0, 0, 1, b'x'], &[file.as_raw_fd()]).unwrap();
    assert!(read_request(&parent).await.is_err());
}
#[tokio::test]
async fn handed_helper_survives_control_eof_and_reports_normal_exit() {
    let directory = tempfile::tempdir().unwrap();
    let completed = directory.path().join("completed");
    let child = Command::new("/bin/sh")
        .args(["-c", "sleep 0.1; printf complete > \"$1\"", "fixture"])
        .arg(&completed)
        .spawn()
        .unwrap();
    let (parent, remote) = UnixStream::pair().unwrap();
    drop(remote);
    let task = tokio::spawn(reap(child, parent));
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(&completed).unwrap(), b"complete");
    let child = Command::new("/bin/sh")
        .args(["-c", "exit 7"])
        .spawn()
        .unwrap();
    let (parent, remote) = UnixStream::pair().unwrap();
    remote.set_nonblocking(true).unwrap();
    let mut remote = tokio::net::UnixStream::from_std(remote).unwrap();
    let task = tokio::spawn(reap(child, parent));
    let mut bytes = [0; 4];
    remote.read_exact(&mut bytes).await.unwrap();
    assert_eq!(i32::from_be_bytes(bytes), 7);
    task.await.unwrap();
}
#[tokio::test]
async fn explicit_abort_is_scoped_to_owned_helper_and_reaped() {
    let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let pid = child.id().unwrap();
    let (parent, remote) = UnixStream::pair().unwrap();
    remote.set_nonblocking(true).unwrap();
    let mut remote = tokio::net::UnixStream::from_std(remote).unwrap();
    let task = tokio::spawn(reap(child, parent));
    remote.write_all(b"A").await.unwrap();
    let mut bytes = [0; 4];
    remote.read_exact(&mut bytes).await.unwrap();
    assert_eq!(i32::from_be_bytes(bytes), -15);
    task.await.unwrap();
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None),
        Err(nix::errno::Errno::ESRCH)
    );
}
#[test]
fn recovery_asset_retains_original_helper_and_binds_manifest_journal_home_version() {
    use std::os::unix::fs::PermissionsExt;
    let (root, mut request) = command_asset();
    let installation = "a".repeat(64);
    let transaction = "12345678-1234-1234-1234-123456789abc";
    let directory = root
        .path()
        .join("desktop-updates/native")
        .join(&installation)
        .join(transaction);
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let helper = directory.join("pacer-update-helper");
    std::fs::rename(&request.path, &helper).unwrap();
    request.path = helper;
    let manifest = serde_json::json!({"schema":1,"binding":{"installationId":installation,"transactionId":transaction},"target":{"id":installation,"pacerHome":root.path(),"version":"0.2.3"},"recoveryJob":{"helper":{"relativePath":"pacer-update-helper","sha256":request.sha256}}});
    let bytes = serde_json::to_vec(&manifest).unwrap();
    for (name,content) in [("prepared.json",bytes.clone()),("journal.json",serde_json::to_vec(&serde_json::json!({"state":"committed","manifestSha256":hex::encode(Sha256::digest(&bytes))})).unwrap())] {
        let path=directory.join(name);std::fs::write(&path,content).unwrap();std::fs::set_permissions(path,std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let asset = Asset::verify(&request, root.path()).unwrap();
    asset.recheck().unwrap();
    request.version = "0.2.4".into();
    assert!(Asset::verify(&request, root.path()).is_err());
    request.version = "0.2.3".into();
    std::fs::write(directory.join("prepared.json"), b"{}").unwrap();
    assert!(asset.recheck().is_err());
    assert!(Asset::verify(&request, root.path()).is_err());
}
#[tokio::test]
async fn unhanded_drop_terminates_and_reaps_exact_owned_child() {
    let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let pid = child.id().unwrap();
    drop(Unhanded(Some(child)));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None)
                == Err(nix::errno::Errno::ESRCH)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn incoming_many_rights_are_all_closed_without_darwin_truncation_leaks() {
    // Run alone so unrelated parallel tests cannot perturb process FD counts.
    if std::env::var_os("PACER_HELPER_FD_TEST_CHILD").is_none() {
        let output=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","serve::native_helper::tests::incoming_many_rights_are_all_closed_without_darwin_truncation_leaks"])
            .env("PACER_HELPER_FD_TEST_CHILD","1").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let file = File::open("/dev/null").unwrap();
    for count in [100, 254] {
        for _ in 0..3 {
            let baseline = std::fs::read_dir("/dev/fd").unwrap().count();
            {
                let (parent, remote) = UnixStream::pair().unwrap();
                parent.set_nonblocking(true).unwrap();
                let parent = tokio::net::UnixStream::from_std(parent).unwrap();
                send_rights(&remote, &[0, 0, 0, 1, b'x'], &vec![file.as_raw_fd(); count]).unwrap();
                assert!(read_request(&parent).await.is_err());
            }
            assert_eq!(std::fs::read_dir("/dev/fd").unwrap().count(), baseline);
        }
    }
}
#[tokio::test]
async fn handed_helper_retains_root_shared_capacity_across_generation_retirement() {
    // Retiring a generation drops its handle, but a handed helper's permit
    // belongs to the Root lifetime until that actual child exits.
    let root = Arc::new(Semaphore::new(4));
    let generation = root.clone();
    let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let (parent, remote) = UnixStream::pair().unwrap();
    remote.set_nonblocking(true).unwrap();
    let mut remote = tokio::net::UnixStream::from_std(remote).unwrap();
    let permit = generation.clone().try_acquire_owned().unwrap();
    let task = tokio::spawn(async move {
        let _permit = permit;
        reap(child, parent).await;
    });
    drop(generation);
    let replacement_generation = root.clone();
    let others = (0..3)
        .map(|_| replacement_generation.clone().try_acquire_owned().unwrap())
        .collect::<Vec<_>>();
    assert!(replacement_generation.clone().try_acquire_owned().is_err());
    remote.write_all(b"A").await.unwrap();
    task.await.unwrap();
    let reclaimed = replacement_generation.try_acquire_owned().unwrap();
    drop(reclaimed);
    drop(others);
    assert_eq!(root.available_permits(), 4);
}

#[test]
fn failure_diagnostic_is_bounded_whitelisted_and_does_not_use_readiness_or_shutdown() {
    use std::io::Write;
    let (home, _) = command_asset();
    let diagnostics = Diagnostics::new(home.path(), 123, 456);
    for (bytes, event) in [
        (b"D\x09\x09".as_slice(), "reported"),
        (b"".as_slice(), "core-diagnostic-unavailable"),
        (b"D".as_slice(), "core-diagnostic-unavailable"),
        (b"D\x09".as_slice(), "core-diagnostic-unavailable"),
        (b"D\x09\x09X".as_slice(), "core-diagnostic-invalid"),
        (b"D\xff\x09".as_slice(), "core-diagnostic-invalid"),
        (b"S\x09\x09".as_slice(), "core-diagnostic-invalid"),
    ] {
        let (channel, mut peer) = UnixStream::pair().unwrap();
        if !bytes.is_empty() {
            peer.write_all(bytes).unwrap();
        }
        let start = std::time::Instant::now();
        receive_failure_diagnostic(&channel, &diagnostics, Stage::Handoff);
        assert!(start.elapsed() < Duration::from_secs(1));
        let text = std::fs::read_to_string(home.path().join("logs/native-helper.log")).unwrap();
        let row: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(row["event"], event);
        // The diagnostic parser only observes bytes; it does not close, signal,
        // reserve, spawn or treat an embedded S as a shutdown request.
        peer.write_all(b"x").unwrap();
    }
}
#[test]
fn failure_diagnostic_closes_all_incoming_rights_without_leaks() {
    if std::env::var_os("PACER_TEST_FAILURE_DIAGNOSTIC_CHILD").is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "serve::native_helper::tests::failure_diagnostic_closes_all_incoming_rights_without_leaks"])
            .env("PACER_TEST_FAILURE_DIAGNOSTIC_CHILD", "1").status().unwrap();
        assert!(status.success());
        return;
    }
    use nix::sys::socket::{ControlMessage, MsgFlags, UnixAddr, sendmsg};
    let (home, _) = command_asset();
    let diagnostics = Diagnostics::new(home.path(), 123, 456);
    let (reader, _writer) = nix::unistd::pipe().unwrap();
    let (channel, peer) = UnixStream::pair().unwrap();
    let before = std::fs::read_dir("/dev/fd").unwrap().count();
    for count in std::iter::repeat_n(100, 20).chain([254]) {
        let fds = vec![reader.as_raw_fd(); count];
        sendmsg::<UnixAddr>(
            peer.as_raw_fd(),
            &[std::io::IoSlice::new(b"D\x09\x09")],
            &[ControlMessage::ScmRights(&fds)],
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        receive_failure_diagnostic(&channel, &diagnostics, Stage::Handoff);
        assert_eq!(std::fs::read_dir("/dev/fd").unwrap().count(), before);
    }
    let text = std::fs::read_to_string(home.path().join("logs/native-helper.log")).unwrap();
    assert!(text.lines().all(
        |line| serde_json::from_str::<serde_json::Value>(line).unwrap()["event"]
            == "core-diagnostic-invalid"
    ));
}
