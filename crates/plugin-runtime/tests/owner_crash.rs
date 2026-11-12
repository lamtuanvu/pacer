#![allow(clippy::unwrap_used)]
//! Crash detection, restart floor, sealed start backoff and stop escalation on
//! the native process owner.

use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use pacer_plugin_runtime::{
    CrashReport, OwnerError, ProcessOwner, SharedOwner, SpawnSpec, StartFailure, TERMINATE_GRACE,
    crash_message, start_lane, terminate_lanes,
};
use serde_json::json;
use std::{
    env,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, mpsc};

const ECHO: &str = r#"process.on('SIGTERM',()=>{if(globalThis.STUBBORN)return;process.exit(143)});const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const m=JSON.parse(text.slice(0,cut));text=text.slice(cut+1);if(m.method==='probe')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{pid:process.pid}}));}}"#;

fn peer(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), script.into()],
        cwd: env::current_dir().unwrap(),
        env: env::vars().collect(),
    }
}

fn stubborn() -> SpawnSpec {
    peer(&format!("globalThis.STUBBORN=true;{ECHO}"))
}

fn shared(owner: ProcessOwner) -> SharedOwner {
    Arc::new(Mutex::new(owner))
}

fn alive(pid: u32) -> bool {
    kill(Pid::from_raw(i32::try_from(pid).unwrap()), None).is_ok()
}

async fn probe(owner: &SharedOwner, id: &str) -> u32 {
    let lane = owner.lock().await.lane(id).unwrap();
    let reply = lane
        .process()
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    u32::try_from(reply["pid"].as_u64().unwrap()).unwrap()
}

fn epoch_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[tokio::test]
async fn a_killed_child_is_reported_before_its_lane_is_replaced() {
    let owner = ProcessOwner::native_for_tests();
    let (sink, mut reports) = mpsc::unbounded_channel::<CrashReport>();
    owner.set_crash_sink(sink);
    let owner = shared(owner);
    owner.lock().await.spawn("fx", &peer(ECHO)).unwrap();
    let pid = probe(&owner, "fx").await;
    let lane = owner.lock().await.lane("fx").unwrap();
    kill(Pid::from_raw(i32::try_from(pid).unwrap()), Signal::SIGKILL).unwrap();

    let report = tokio::time::timeout(Duration::from_secs(5), reports.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (report.id.as_str(), report.reason.as_str()),
        ("fx", "exited on SIGKILL")
    );
    // Undelivered: the dead lane is never handed out or replaced.
    assert!(owner.lock().await.find_plugin("fx").is_none());
    assert_eq!(
        owner.lock().await.ensure("fx", &peer(ECHO)),
        Err(OwnerError::Retiring("fx".into()))
    );
    // A start racing the report fails like an in-flight call instead of respawning.
    let racing = {
        let owner = owner.clone();
        tokio::spawn(async move {
            let until = Instant::now() + Duration::from_secs(10);
            start_lane(&owner, "fx", &peer(ECHO), None, until, None)
                .await
                .err()
                .map(|error| error.to_string())
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!racing.is_finished());
    report.done.send(()).unwrap();
    assert_eq!(
        racing.await.unwrap().as_deref(),
        Some("plugin fx exited on SIGKILL")
    );
    lane.wait_settled(Duration::from_secs(5)).await;
    assert!(lane.is_settled());
    assert_eq!(
        crash_message(&lane, "fx", "ui.render").await.as_deref(),
        Some("ui.render: plugin fx exited on SIGKILL")
    );

    let floor = owner.lock().await.restart_floor("fx").unwrap();
    let ahead = floor.saturating_duration_since(Instant::now());
    assert!(
        ahead > Duration::from_millis(500) && ahead <= Duration::from_secs(1),
        "{ahead:?}"
    );
    match owner.lock().await.ensure("fx", &peer(ECHO)) {
        Err(OwnerError::Backoff { id, at }) => assert_eq!((id.as_str(), at), ("fx", floor)),
        other => panic!("expected backoff, got {other:?}"),
    }
    owner.lock().await.clear_restart_floor("fx");
    assert_eq!(owner.lock().await.ensure("fx", &peer(ECHO)), Ok(true));
    owner.lock().await.terminate("fx").await.unwrap();
    assert!(
        reports.try_recv().is_err(),
        "a requested stop is not a crash"
    );
}

#[tokio::test]
async fn a_crash_looping_child_cannot_restart_faster_than_the_floor() {
    let owner = shared(ProcessOwner::native_for_tests());
    let crashing = peer("process.exit(3)");
    let far = || Instant::now() + Duration::from_secs(10);
    let lane = start_lane(&owner, "loop", &crashing, None, far(), None)
        .await
        .unwrap();
    lane.wait_settled(Duration::from_secs(5)).await;
    assert_eq!(
        lane.process().exit_reason().as_deref(),
        Some("exited with code 3")
    );

    let started = Instant::now();
    let second = start_lane(&owner, "loop", &crashing, None, far(), None)
        .await
        .unwrap();
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(900),
        "first floor is 1 s, waited {waited:?}"
    );
    second.wait_settled(Duration::from_secs(5)).await;

    // The second crash doubles the floor; a call that cannot outlast it fails fast.
    let started = Instant::now();
    let refused = start_lane(
        &owner,
        "loop",
        &crashing,
        None,
        Instant::now() + Duration::from_millis(500),
        None,
    )
    .await;
    assert!(
        matches!(refused, Err(StartFailure::BeforeStartup)),
        "{:?}",
        refused.err()
    );
    assert!(started.elapsed() < Duration::from_millis(400));
}

#[tokio::test]
async fn three_crashes_hold_the_plugin_until_it_is_enabled_again() {
    let owner = shared(ProcessOwner::native_for_tests());
    let crashing = peer("process.exit(3)");
    let far = || Instant::now() + Duration::from_secs(10);
    for _ in 0..3 {
        let lane = start_lane(&owner, "loop", &crashing, None, far(), None)
            .await
            .unwrap();
        lane.wait_settled(Duration::from_secs(5)).await;
    }
    // Core marks it failing; the owner refuses outright instead of waiting out a floor.
    assert_eq!(
        owner.lock().await.ensure("loop", &crashing),
        Err(OwnerError::Failing("loop".into()))
    );
    let started = Instant::now();
    let refused = start_lane(&owner, "loop", &crashing, None, far(), None).await;
    assert_eq!(
        refused.err().map(|error| error.to_string()).as_deref(),
        Some("plugin loop is failing: 3 failures within a minute")
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    owner.lock().await.clear_restart_floor("loop");
    assert_eq!(owner.lock().await.ensure("loop", &peer(ECHO)), Ok(true));
    owner.lock().await.terminate("loop").await.unwrap();
}

#[tokio::test]
async fn a_sealed_next_start_delays_the_first_spawn() {
    let owner = shared(ProcessOwner::native_for_tests());
    let at = epoch_ms() + 800;
    let refused = start_lane(
        &owner,
        "fx",
        &peer(ECHO),
        Some(at),
        Instant::now() + Duration::from_millis(300),
        None,
    )
    .await;
    assert!(
        matches!(refused, Err(StartFailure::BeforeStartup)),
        "{:?}",
        refused.err()
    );
    assert!(owner.lock().await.is_empty());

    let started = Instant::now();
    start_lane(
        &owner,
        "fx",
        &peer(ECHO),
        Some(at),
        Instant::now() + Duration::from_secs(10),
        None,
    )
    .await
    .unwrap();
    assert!(epoch_ms() >= at, "spawned before the sealed nextStartAt");
    assert!(started.elapsed() < Duration::from_secs(3));
    owner.lock().await.terminate("fx").await.unwrap();
}

#[tokio::test]
async fn a_stop_escalates_to_sigkill_when_the_child_ignores_sigterm() {
    let owner = ProcessOwner::native_for_tests();
    let (sink, mut reports) = mpsc::unbounded_channel::<CrashReport>();
    owner.set_crash_sink(sink);
    let owner = shared(owner);
    owner.lock().await.spawn("fx", &stubborn()).unwrap();
    let pid = probe(&owner, "fx").await;
    let lane = owner.lock().await.lane("fx").unwrap();
    let started = Instant::now();
    owner.lock().await.terminate("fx").await.unwrap();
    let took = started.elapsed();
    assert!(
        took >= TERMINATE_GRACE - Duration::from_millis(100),
        "SIGKILL came early: {took:?}"
    );
    assert!(took < TERMINATE_GRACE + Duration::from_secs(2), "{took:?}");
    assert_eq!(
        lane.process().exit_reason().as_deref(),
        Some("exited on SIGKILL")
    );
    assert!(!alive(pid));
    assert!(reports.try_recv().is_err());
}

#[tokio::test]
async fn a_cooperative_child_stops_on_sigterm_without_waiting_for_the_grace() {
    let owner = shared(ProcessOwner::native_for_tests());
    owner.lock().await.spawn("fx", &peer(ECHO)).unwrap();
    let pid = probe(&owner, "fx").await;
    let lane = owner.lock().await.lane("fx").unwrap();
    let started = Instant::now();
    owner.lock().await.terminate("fx").await.unwrap();
    assert!(started.elapsed() < TERMINATE_GRACE);
    assert!(lane.process().exit_reason().is_some());
    assert!(!alive(pid));
}

#[tokio::test]
async fn closing_the_owner_refuses_spawns_and_terminates_every_child() {
    let owner = shared(ProcessOwner::native_for_tests());
    owner.lock().await.spawn("a", &peer(ECHO)).unwrap();
    owner.lock().await.spawn("b", &stubborn()).unwrap();
    let pids = [probe(&owner, "a").await, probe(&owner, "b").await];
    let lanes = owner.lock().await.close();
    assert_eq!(lanes.len(), 2);
    assert_eq!(
        owner.lock().await.ensure("c", &peer(ECHO)),
        Err(OwnerError::Closing)
    );
    assert_eq!(
        owner.lock().await.spawn("d", &peer(ECHO)),
        Err(OwnerError::Closing)
    );
    let refused = start_lane(
        &owner,
        "c",
        &peer(ECHO),
        None,
        Instant::now() + Duration::from_secs(5),
        None,
    )
    .await;
    assert!(
        matches!(refused, Err(StartFailure::Owner(OwnerError::Closing))),
        "{:?}",
        refused.err()
    );
    let started = Instant::now();
    terminate_lanes(lanes).await;
    // Both stop concurrently: one grace, not two.
    assert!(started.elapsed() < TERMINATE_GRACE * 2);
    assert!(
        pids.iter().all(|pid| !alive(*pid)),
        "orphaned children: {pids:?}"
    );
}

#[tokio::test]
async fn a_child_that_closes_its_stdout_is_killed_and_counted_as_a_crash() {
    let owner = ProcessOwner::native_for_tests();
    let (sink, mut reports) = mpsc::unbounded_channel::<CrashReport>();
    owner.set_crash_sink(sink);
    let owner = shared(owner);
    let script =
        "process.on('SIGTERM',()=>{});require('fs').closeSync(1);setInterval(()=>{},1000);";
    owner.lock().await.spawn("mute", &peer(script)).unwrap();
    let lane = owner.lock().await.lane("mute").unwrap();
    let report = tokio::time::timeout(TERMINATE_GRACE + Duration::from_secs(5), reports.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (report.id.as_str(), report.reason.as_str()),
        ("mute", "exited on SIGKILL")
    );
    drop(report);
    lane.wait_settled(Duration::from_secs(5)).await;
    assert!(owner.lock().await.restart_floor("mute").is_some());
}

#[tokio::test]
async fn a_cooperative_child_that_closes_its_stdout_stops_on_sigterm() {
    let owner = ProcessOwner::native_for_tests();
    let (sink, mut reports) = mpsc::unbounded_channel::<CrashReport>();
    owner.set_crash_sink(sink);
    let owner = shared(owner);
    let started = Instant::now();
    owner
        .lock()
        .await
        .spawn(
            "quiet",
            &peer("require('fs').closeSync(1);setInterval(()=>{},1000);"),
        )
        .unwrap();
    let report = tokio::time::timeout(TERMINATE_GRACE + Duration::from_secs(5), reports.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (report.id.as_str(), report.reason.as_str()),
        ("quiet", "exited on SIGTERM")
    );
    assert!(
        started.elapsed() < TERMINATE_GRACE,
        "{:?}",
        started.elapsed()
    );
}
