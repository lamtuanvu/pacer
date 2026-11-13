#![allow(clippy::unwrap_used)]
//! A request admitted behind a stop or a closing owner never reaches the child.

use pacer_plugin_runtime::{NativeHostSession, OwnerError, ProcessOwner, SpawnSpec};
use serde_json::json;
use std::{
    env, fs,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// Ignores SIGTERM, records each request's method in `$RECORD` and answers it.
const RECORDER: &str = r"const fs=require('fs');process.on('SIGTERM',()=>{});const r=Bun.stdin.stream().getReader();let t='';for(;;){const {value,done}=await r.read();if(done)break;t+=new TextDecoder().decode(value);for(let i=t.indexOf('\n');i>=0;i=t.indexOf('\n')){const m=JSON.parse(t.slice(0,i));t=t.slice(i+1);fs.appendFileSync(process.env.RECORD,m.method+'\n');console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));}}";

fn recorder(record: &Path) -> SpawnSpec {
    let mut env = env::vars().collect::<std::collections::HashMap<_, _>>();
    env.insert("RECORD".into(), record.to_str().unwrap().into());
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), RECORDER.into()],
        cwd: env::current_dir().unwrap(),
        env,
    }
}

fn received(record: &Path) -> Vec<String> {
    fs::read_to_string(record)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// The bridge requires a private home; temp dirs follow the process umask.
fn temp_home() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_queued_behind_a_stop_never_reaches_the_child() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let owner = Arc::new(Mutex::new(ProcessOwner::native_for_tests()));
    owner.lock().await.spawn("fx", &recorder(&record)).unwrap();
    let lane = owner.lock().await.lane("fx").unwrap();
    lane.call(None, "probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    let turn = lane.gate().write().await;
    let queued = {
        let lane = lane.clone();
        tokio::spawn(async move {
            lane.call(None, "late", json!({}), Duration::from_secs(5), None)
                .await
        })
    };
    let stopping = {
        let lane = lane.clone();
        tokio::spawn(async move { lane.process().terminate().await })
    };
    until("the stop", || lane.process().is_stopping()).await;
    // The child outlives SIGTERM for the grace, so a write would be answered.
    assert!(lane.process().is_alive());
    drop(turn);
    let refused = queued.await.unwrap();
    assert_eq!(
        refused.err().map(|error| error.to_string()).as_deref(),
        Some("the plugin is stopping")
    );
    assert_eq!(received(&record), vec!["probe"]);
    let _ = stopping.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_lane_is_handed_out_once_teardown_began() {
    let home = temp_home();
    let record = home.path().join("record");
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let owner = session.owner().clone();
    owner.lock().await.spawn("fx", &recorder(&record)).unwrap();
    let lane = owner.lock().await.lane("fx").unwrap();
    lane.call(None, "probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    // Teardown closes the roster without the owner lock, so the child stays tracked.
    let held = owner.clone().lock_owned().await;
    let stopping = tokio::spawn(session.shutdown());
    until("the stop", || lane.process().is_stopping()).await;
    assert!(held.lane("fx").is_some());
    assert_eq!(
        held.lane_for_call("fx")
            .err()
            .map(|error| error.to_string()),
        Some(OwnerError::Closing.to_string())
    );
    drop(held);
    assert_eq!(received(&record), vec!["probe"]);
    let _ = stopping.await;
}
