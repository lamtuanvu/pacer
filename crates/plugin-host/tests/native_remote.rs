#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{BrokerError, NativeRemote, RemoteHost, RemoteIntent, RemoteOperation};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};
const ID: &str = "t-20261102-155709-d07a";
struct Host {
    replies: VecDeque<Value>,
    calls: Vec<RemoteOperation>,
}
impl RemoteHost for Host {
    fn fingerprint(&self) -> String {
        "configured".into()
    }
    async fn invoke(&mut self, op: RemoteOperation, _: &Value) -> Result<Value, BrokerError> {
        self.calls.push(op);
        Ok(self.replies.pop_front().unwrap())
    }
}
fn result(code: i32, out: &str, err: &str) -> Value {
    json!({"code":code,"stdout":out,"stderr":err,"timedOut":false})
}
fn fixture(replies: Vec<Value>) -> (std::path::PathBuf, NativeRemote<Host>) {
    let root = std::env::temp_dir().join(format!("pacer-remote-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let root = fs::canonicalize(root).unwrap();
    TaskStore::open(&root).unwrap().insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","executorProvider":"pacer-exec-direct","executor":"tool@host","attempts":[],"brief":{"repo":root}}),1.0).unwrap();
    let intent = RemoteIntent {
        attempt: 1,
        provider_id: "pacer-exec-direct".into(),
        executor: "tool@host".into(),
        alias: "host".into(),
        host_fingerprint: "configured".into(),
        repo_top: root.to_string_lossy().into_owned(),
        origin_hash: "a".repeat(64),
        checkout: "~/repo".into(),
        tag: "repo-12345678".into(),
        base_sha: "b".repeat(40),
        base: "main".into(),
    };
    let remote = NativeRemote::issue(
        &root,
        ID,
        intent,
        Host {
            replies: replies.into(),
            calls: vec![],
        },
        json!({"argv":["tool"],"stdin":"private prompt"}),
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    (root, remote)
}
#[tokio::test]
async fn prepare_claim_start_and_exit_receipts_are_journaled_and_one_use() {
    let work = format!("/remote/.pacer-remote/worktrees/repo-12345678/{ID}-1");
    let (root, mut remote) = fixture(vec![
        result(0, &format!("worktree={work}\nbranch=pacer/{ID}\n"), ""),
        json!({"pid":123}),
        json!({"alive":false,"exit":0,"complete":true,"stdoutBase64":"b2s=","stderrBase64":""}),
    ]);
    let p = json!({"taskId":ID,"attempt":1.0});
    let ready = remote
        .answer("capability.hosts.prepareOwned", &p)
        .await
        .unwrap();
    assert_eq!(ready["worktree"], work);
    let claimed = remote
        .answer("capability.hosts.claimOwned", &p)
        .await
        .unwrap();
    assert_eq!(
        claimed["remoteDir"],
        format!("/remote/.pacer-remote/runs/{ID}/1")
    );
    assert_eq!(
        remote
            .answer("capability.hosts.startOwned", &p)
            .await
            .unwrap()["pid"],
        123
    );
    assert!(
        remote
            .answer("capability.hosts.startOwned", &p)
            .await
            .is_err()
    );
    assert_eq!(
        remote
            .answer("capability.hosts.pollOwned", &p)
            .await
            .unwrap(),
        json!({"state":"exited","exitCode":0})
    );
    assert_eq!(
        remote
            .answer("capability.hosts.readOwnedOutput", &p)
            .await
            .unwrap()["stdoutBase64"],
        "b2s="
    );
    let task = TaskStore::open(&root).unwrap().read(ID).unwrap().unwrap();
    assert_eq!(task["executorExitReceipt"]["exitCode"], 0);
    assert!(task.get("startIntent").is_some());
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn lost_prepare_is_recover_only_and_foreign_facts_never_claim() {
    let (root, mut remote) = fixture(vec![result(
        0,
        "worktree=/foreign\nbranch=pacer/foreign\n",
        "",
    )]);
    let p = json!({"taskId":ID,"attempt":1});
    assert!(
        remote
            .answer("capability.hosts.prepareOwned", &p)
            .await
            .is_err()
    );
    assert!(
        remote
            .answer("capability.hosts.claimOwned", &p)
            .await
            .is_err()
    );
    assert!(
        remote
            .answer("capability.hosts.prepareOwned", &p)
            .await
            .is_err()
    );
    let t = TaskStore::open(&root).unwrap().read(ID).unwrap().unwrap();
    assert!(t.get("remotePrepareIntent").is_some());
    assert!(t.get("run").is_none());
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn missing_base_allows_one_bundle_retry_and_incomplete_exit_stays_uncertain() {
    let work = format!("/remote/.pacer-remote/worktrees/repo-12345678/{ID}-1");
    let (root, mut remote) = fixture(vec![
        result(3, "", "missing-base\u{feff}"),
        result(0, &format!("worktree={work}\nbranch=pacer/{ID}\n"), ""),
        json!({"pid":124}),
        json!({"alive":false,"exit":0,"complete":false,"stdoutBase64":"","stderrBase64":""}),
    ]);
    let p = json!({"taskId":ID,"attempt":1});
    remote
        .answer("capability.hosts.prepareOwned", &p)
        .await
        .unwrap();
    remote
        .answer("capability.hosts.claimOwned", &p)
        .await
        .unwrap();
    remote
        .answer("capability.hosts.startOwned", &p)
        .await
        .unwrap();
    assert_eq!(
        remote
            .answer("capability.hosts.pollOwned", &p)
            .await
            .unwrap(),
        json!({"state":"uncertain","exitCode":null})
    );
    assert!(
        remote
            .answer("capability.hosts.readOwnedOutput", &p)
            .await
            .is_err()
    );
    let task = TaskStore::open(&root).unwrap().read(ID).unwrap().unwrap();
    assert!(
        task["remotePrepareIntent"]
            .get("missingBaseReceiptAt")
            .is_some()
    );
    assert!(
        task["remotePrepareIntent"]
            .get("bundleRetryIssuedAt")
            .is_some()
    );
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn resumed_remote_run_can_only_observe_and_never_repeat_start() {
    let work = format!("/remote/.pacer-remote/worktrees/repo-12345678/{ID}-1");
    let (root, mut original) = fixture(vec![
        result(0, &format!("worktree={work}\nbranch=pacer/{ID}\n"), ""),
        json!({"pid":123}),
    ]);
    let p = json!({"taskId":ID,"attempt":1});
    original
        .answer("capability.hosts.prepareOwned", &p)
        .await
        .unwrap();
    original
        .answer("capability.hosts.claimOwned", &p)
        .await
        .unwrap();
    original
        .answer("capability.hosts.startOwned", &p)
        .await
        .unwrap();
    let task = TaskStore::open(&root).unwrap().read(ID).unwrap().unwrap();
    let intent = serde_json::from_value(task["remotePrepareIntent"].clone()).unwrap();
    let mut resumed = NativeRemote::issue(
        &root,
        ID,
        intent,
        Host {
            replies: vec![json!({"alive":true,"exit":null,"complete":false})].into(),
            calls: vec![],
        },
        json!({}),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    assert!(
        resumed
            .answer("capability.hosts.startOwned", &p)
            .await
            .is_err()
    );
    assert!(
        resumed
            .answer("capability.hosts.prepareOwned", &p)
            .await
            .is_err()
    );
    assert_eq!(
        resumed
            .answer("capability.hosts.pollOwned", &p)
            .await
            .unwrap()["state"],
        "running"
    );
    assert!(
        resumed
            .answer(
                "capability.hosts.stopOwned",
                &json!({"taskId":ID,"attempt":1,"graceMs":0})
            )
            .await
            .is_err()
    );
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn pending_stop_can_be_issued_on_a_resumed_run_and_requires_matching_fresh_report() {
    let work = format!("/remote/.pacer-remote/worktrees/repo-12345678/{ID}-1");
    let (root, mut original) = fixture(vec![
        result(0, &format!("worktree={work}\nbranch=pacer/{ID}\n"), ""),
        json!({"pid":123}),
    ]);
    let p = json!({"taskId":ID,"attempt":1});
    original
        .answer("capability.hosts.prepareOwned", &p)
        .await
        .unwrap();
    original
        .answer("capability.hosts.claimOwned", &p)
        .await
        .unwrap();
    original
        .answer("capability.hosts.startOwned", &p)
        .await
        .unwrap();
    let mut store = TaskStore::open(&root).unwrap();
    let t = store.read(ID).unwrap().unwrap();
    let t=store.update(ID,t["rev"].as_i64().unwrap(),5.0,|t|t["stopPending"]=json!({"providerId":"pacer-exec-direct","attempt":1,"requestedAt":5,"graceMs":0})).unwrap();
    let mut stop = NativeRemote::issue(
        &root,
        ID,
        serde_json::from_value(t["remotePrepareIntent"].clone()).unwrap(),
        Host {
            replies: vec![
                json!({"code":143,"killed":false}),
                json!({"exit":143,"alive":false}),
            ]
            .into(),
            calls: vec![],
        },
        json!({}),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap()
    .with_stop_grant(0)
    .unwrap();
    assert_eq!(
        stop.answer(
            "capability.hosts.stopOwned",
            &json!({"taskId":ID,"attempt":1,"graceMs":0})
        )
        .await
        .unwrap()["code"],
        143
    );
    assert_eq!(
        store.read(ID).unwrap().unwrap()["executorExitReceipt"]["exitCode"],
        143
    );
    fs::remove_dir_all(root).unwrap();
}
