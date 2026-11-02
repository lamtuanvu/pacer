#![allow(clippy::unwrap_used)]
use super::*;
use std::{os::unix::fs::PermissionsExt, process::Command};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pacer-journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(path.join(".pacer-disposable-test-home"), b"journal").unwrap();
        Self(path)
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("orca.json")).unwrap()).unwrap()
    }
    fn inode(&self) -> u64 {
        fs::symlink_metadata(self.0.join("orca.json"))
            .unwrap()
            .ino()
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn add(key: &'static str) -> impl FnOnce(&mut Value) -> Result<(), BrokerError> {
    move |s| {
        s["removed"][key] = json!({"id":key,"path":"/x","at":1});
        Ok(())
    }
}

#[tokio::test]
async fn root_replacement_while_waiting_for_lock_is_denied_without_new_lock() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let home = Home::new();
    let retained = Home::new();
    let journal = Journal::new(&home.0).unwrap();
    let lock_path = home.0.join("orca/coordinator.lock");
    fs::write(&lock_path, b"occupied").unwrap();
    let mut acquiring = Box::pin(journal.lock());
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(
        acquiring.as_mut().poll(&mut context),
        Poll::Pending
    ));

    let moved = retained.0.join("original");
    fs::rename(&home.0, &moved).unwrap();
    fs::create_dir(&home.0).unwrap();
    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(home.0.join("orca")).unwrap();
    fs::set_permissions(home.0.join("orca"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(home.0.join(".pacer-disposable-test-home"), b"replacement").unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), acquiring)
        .await
        .unwrap();
    assert!(
        result.is_err(),
        "a waited lock must retain its original root authority"
    );
    assert!(!lock_path.exists());
    assert!(!home.0.join("orca.json").exists());
    assert_eq!(
        fs::read(moved.join("orca/coordinator.lock")).unwrap(),
        b"occupied"
    );
}

#[tokio::test]
async fn journals_created_before_any_write_accept_each_others_completed_writes() {
    let home = Home::new();
    let mut a = Journal::new(&home.0).unwrap();
    let mut b = Journal::new(&home.0).unwrap();
    a.mutate(add("a")).await.unwrap();
    let first = home.inode();
    b.mutate(add("b")).await.unwrap();
    let second = home.inode();
    a.mutate(add("c")).await.unwrap();
    assert_ne!(first, second);
    assert_ne!(second, home.inode());
    let state = home.state();
    for key in ["a", "b", "c"] {
        assert_eq!(state["removed"][key]["id"], key);
    }
    assert_eq!(
        fs::metadata(home.0.join("orca.json")).unwrap().mode() & 0o777,
        0o600
    );
}

/// Run the actual TypeScript `updateOrcaState` against a disposable home.
fn ts_update(home: &Path, worker: &str) {
    let state = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/exec/orca/state.ts");
    let script = format!(
        "const {{ updateOrcaState }} = await import({:?}); updateOrcaState({{ pacerHome: process.env.PACER_HOME }}, s => {{ s.workers[{worker:?}] = {{ dispatchId: {worker:?}, taskId: 't', executor: 'e', worktree: null, terminal: null, startedAt: 1 }}; }});",
        state.to_str().unwrap()
    );
    let mut child = Command::new("bun")
        .args(["-e", &script])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("PACER_HOME", home)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("bun updateOrcaState timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success());
}

#[tokio::test]
async fn native_journal_reads_and_preserves_actual_typescript_updates() {
    let home = Home::new();
    let mut native = Journal::new(&home.0).unwrap();
    native.mutate(add("native-1")).await.unwrap();
    let before = home.inode();
    ts_update(&home.0, "ts-1");
    assert_ne!(before, home.inode());
    assert_eq!(
        native.read().unwrap()["workers"]["ts-1"]["dispatchId"],
        "ts-1"
    );
    native.mutate(add("native-2")).await.unwrap();
    ts_update(&home.0, "ts-2");
    native.mutate(add("native-3")).await.unwrap();
    let state = home.state();
    for worker in ["ts-1", "ts-2"] {
        assert_eq!(state["workers"][worker]["dispatchId"], worker);
    }
    for key in ["native-1", "native-2", "native-3"] {
        assert_eq!(state["removed"][key]["id"], key);
    }
}

fn foreign_write(home: &Path, state: &Value) {
    let stage = home.join("orca.json.foreign");
    fs::write(&stage, serde_json::to_vec(state).unwrap()).unwrap();
    fs::rename(stage, home.join("orca.json")).unwrap();
}
fn lock_path(home: &Path, name: &str) -> PathBuf {
    home.join("orca").join(format!("{name}.lock"))
}

#[tokio::test]
async fn construction_with_existing_or_absent_state_then_repeated_transaction_writes() {
    for seed in [
        None,
        Some(br#"{"run":"r","workers":{"w":{"x":1}}}"#.as_slice()),
    ] {
        let home = Home::new();
        if let Some(seed) = seed {
            fs::write(home.0.join("orca.json"), seed).unwrap();
        }
        let mut j = Journal::new(&home.0).unwrap();
        let lock = j.lock().await.unwrap();
        let (mut edit, mut state) = j.edit(&lock, "coordinator").unwrap();
        state["coordinator"] = json!("one");
        edit.write(&state).unwrap();
        let first = home.inode();
        state["coordinator"] = json!("two");
        edit.write(&state).unwrap();
        assert_ne!(first, home.inode());
        edit.write(&state).unwrap();
        lock.release().unwrap();
        assert!(!lock_path(&home.0, "coordinator").exists());
        assert_eq!(home.state()["coordinator"], "two");
        assert_eq!(
            home.state()["run"],
            if seed.is_some() {
                json!("r")
            } else {
                Value::Null
            }
        );
        j.mutate(add("after")).await.unwrap();
        assert_eq!(home.state()["removed"]["after"]["id"], "after");
    }
}

#[tokio::test]
async fn foreign_write_before_the_transaction_read_wins_and_after_it_is_denied() {
    let home = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    j.mutate(add("mine")).await.unwrap();
    foreign_write(&home.0, &json!({"run":"foreign-before"}));
    let lock = j.lock().await.unwrap();
    let (mut edit, mut state) = j.edit(&lock, "coordinator").unwrap();
    assert_eq!(state["run"], "foreign-before");
    state["coordinator"] = json!("mine");
    edit.write(&state).unwrap();
    foreign_write(&home.0, &json!({"run":"foreign-after"}));
    assert!(edit.write(&state).is_err());
    drop(lock);
    assert_eq!(home.state(), json!({"run":"foreign-after"}));
    let other = Journal::new(&home.0).unwrap();
    assert_eq!(other.read().unwrap()["run"], "foreign-after");
    assert_eq!(j.read().unwrap()["run"], "foreign-after");
    j.mutate(add("next")).await.unwrap();
    assert_eq!(home.state()["run"], "foreign-after");
}

#[tokio::test]
async fn failed_change_publishes_nothing_and_releases_the_lock() {
    let home = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    j.mutate(add("kept")).await.unwrap();
    let before = (home.state(), home.inode());
    let failed: Result<(), _> = j
        .mutate(|s| {
            s["removed"]["lost"] = json!({});
            Err(BrokerError::Effect("injected".into()))
        })
        .await;
    assert!(failed.is_err());
    assert_eq!((home.state(), home.inode()), before);
    assert!(!lock_path(&home.0, "coordinator").exists());
}

#[tokio::test]
async fn edit_entry_binds_the_expected_named_lock_of_this_home() {
    let home = Home::new();
    let elsewhere = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    let mut second = Journal::new(&home.0).unwrap();
    let foreign = Journal::new(&elsewhere.0).unwrap();
    let group = j.lock_named("orca-group").await.unwrap();
    assert!(j.lock_named("other").await.is_err());
    assert!(j.edit(&group, "coordinator").is_err());
    let (mut edit, state) = j.edit(&group, "orca-group").unwrap();
    edit.write(&state).unwrap();
    let theirs = foreign.lock_named("orca-group").await.unwrap();
    assert!(second.edit(&theirs, "orca-group").is_err());
    drop(theirs);
    let (mut edit, state) = second.edit(&group, "orca-group").unwrap();
    edit.write(&state).unwrap();
    drop(group);
    assert!(!elsewhere.0.join("orca.json").exists());
    let coordinator = j.lock().await.unwrap();
    let (mut edit, state) = j.edit(&coordinator, "coordinator").unwrap();
    edit.write(&state).unwrap();
}

#[tokio::test]
async fn replaced_or_removed_lock_denies_entry_and_later_writes() {
    let home = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    let path = lock_path(&home.0, "coordinator");
    let lock = j.lock().await.unwrap();
    let (mut edit, mut state) = j.edit(&lock, "coordinator").unwrap();
    state["run"] = json!("held");
    edit.write(&state).unwrap();
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    state["run"] = json!("after-replacement");
    assert!(edit.write(&state).is_err());
    assert!(j.edit(&lock, "coordinator").is_err());
    fs::remove_file(&path).unwrap();
    assert!(j.edit(&lock, "coordinator").is_err());
    drop(lock);
    assert_eq!(home.state()["run"], "held");
}

#[tokio::test]
async fn group_then_coordinator_lock_order_still_mutates() {
    let home = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    let group = j.lock_named("orca-group").await.unwrap();
    let outer = j.read().unwrap();
    j.mutate(add("inner")).await.unwrap();
    assert!(outer["removed"]["inner"].is_null());
    assert_eq!(j.read().unwrap()["removed"]["inner"]["id"], "inner");
    group.release().unwrap();
    assert!(!lock_path(&home.0, "orca-group").exists());
}

#[tokio::test]
async fn link_or_replaced_home_denies_reads_entry_and_publication() {
    use std::os::unix::fs::symlink;
    let home = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    j.mutate(add("seed")).await.unwrap();
    let target = home.0.join("orca.json");
    fs::write(home.0.join("other.json"), br#"{"run":"secret"}"#).unwrap();
    fs::remove_file(&target).unwrap();
    symlink(home.0.join("other.json"), &target).unwrap();
    assert!(j.read().is_err());
    assert!(j.mutate(add("via-link")).await.is_err());
    fs::remove_file(&target).unwrap();
    fs::hard_link(home.0.join("other.json"), &target).unwrap();
    assert!(j.read().is_err());
    assert!(j.mutate(add("via-hardlink")).await.is_err());
    assert_eq!(
        fs::read(home.0.join("other.json")).unwrap(),
        br#"{"run":"secret"}"#
    );
    fs::remove_file(&target).unwrap();
    j.mutate(add("restored")).await.unwrap();
    let moved = home.0.with_extension("moved");
    fs::rename(&home.0, &moved).unwrap();
    fs::create_dir(&home.0).unwrap();
    fs::create_dir(home.0.join("orca")).unwrap();
    fs::set_permissions(home.0.join("orca"), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(j.read().is_err());
    assert!(j.lock().await.is_err());
    assert!(!lock_path(&home.0, "coordinator").exists());
    assert!(!home.0.join("orca.json").exists());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(moved.join("orca.json")).unwrap()).unwrap()["removed"]
            ["restored"]["id"],
        "restored"
    );
    fs::remove_dir_all(moved).unwrap();
}

#[tokio::test]
async fn home_replaced_after_lock_denies_edit_entry() {
    let home = Home::new();
    let mut j = Journal::new(&home.0).unwrap();
    let lock = j.lock().await.unwrap();
    let moved = home.0.with_extension("moved");
    fs::rename(&home.0, &moved).unwrap();
    fs::create_dir(&home.0).unwrap();
    assert!(j.edit(&lock, "coordinator").is_err());
    assert!(!home.0.join("orca.json").exists());
    fs::remove_dir_all(moved).unwrap();
}
