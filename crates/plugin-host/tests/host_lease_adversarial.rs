#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    AuthorityError, BrokerError, CapabilityEffect, HostProvider, NativeHosts, ProviderSnapshot,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
fn snapshot() -> ProviderSnapshot {
    ProviderSnapshot {
        alias: "box".into(),
        host_fingerprint: "host-1".into(),
        caller_generation: "caller-1".into(),
        provider_generation: "provider-1".into(),
        provider_process: 1,
    }
}
struct Provider {
    state: Arc<Mutex<ProviderSnapshot>>,
    closed: Arc<AtomicUsize>,
    reply: Value,
    drift: Option<&'static str>,
}
impl HostProvider for Provider {
    fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
        Some(self.state.lock().unwrap().clone())
    }
    async fn invoke(&mut self, m: &str, _: Value) -> Result<Value, BrokerError> {
        if m == "hostRunner.close" {
            self.closed.fetch_add(1, Ordering::SeqCst);
            return Ok(json!({"ok":true}));
        }
        if self.drift == Some(m) {
            self.state.lock().unwrap().provider_generation = "changed".into();
        }
        if m == "hostRunner.open" {
            Ok(json!({"session":"private-provider-session"}))
        } else {
            Ok(self.reply.clone())
        }
    }
}
fn native(reply: Value, drift: Option<&'static str>) -> (NativeHosts<Provider>, Arc<AtomicUsize>) {
    let state = Arc::new(Mutex::new(snapshot()));
    let closed = Arc::new(AtomicUsize::new(0));
    (
        NativeHosts::new(
            Provider {
                state,
                closed: closed.clone(),
                reply,
                drift,
            },
            [snapshot()],
        ),
        closed,
    )
}
#[tokio::test]
async fn malformed_or_oversized_reply_retires_lease_and_closes_exact_provider() {
    for reply in [
        json!({"code":0,"stdout":"1234","stderr":"5678","timedOut":false}),
        json!({"code":0,"stdout":"ok","stderr":"","timedOut":"no"}),
        json!({"code":256,"stdout":"ok","stderr":"","timedOut":false}),
        json!({"code":0,"stdout":null,"stderr":"","timedOut":false}),
    ] {
        let (mut n, closed) = native(reply, None);
        n.call(
            "capability.hosts.open",
            json!({"alias":"box","session":"broker-session"}),
        )
        .await
        .unwrap();
        assert!(n.call("capability.hosts.run",json!({"session":"broker-session","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":4})).await.is_err());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert!(
            n.call("capability.hosts.run", json!({"session":"broker-session"}))
                .await
                .is_err()
        );
    }
}
#[tokio::test]
async fn generation_edit_during_open_or_run_never_publishes_a_stale_result() {
    for method in ["hostRunner.open", "hostRunner.run"] {
        let (mut n, closed) = native(
            json!({"code":0,"stdout":"ok","stderr":"","timedOut":false}),
            Some(method),
        );
        let opened = n
            .call(
                "capability.hosts.open",
                json!({"alias":"box","session":"broker-session"}),
            )
            .await;
        if method.ends_with("open") {
            assert!(opened.is_err());
        } else {
            opened.unwrap();
            assert!(n.call("capability.hosts.run",json!({"session":"broker-session","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":4})).await.is_err());
        }
        assert_eq!(closed.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn cancelled_close_retains_exact_session_for_owned_retirement() {
    struct Closing {
        calls: Arc<AtomicUsize>,
    }
    impl HostProvider for Closing {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(snapshot())
        }
        async fn invoke(&mut self, m: &str, p: Value) -> Result<Value, BrokerError> {
            if m == "hostRunner.open" {
                return Ok(json!({"session":"provider-session-1234"}));
            }
            assert_eq!(p["session"], "provider-session-1234");
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                std::future::pending::<()>().await;
            }
            Ok(json!({}))
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let mut native = NativeHosts::new(
        Closing {
            calls: calls.clone(),
        },
        [snapshot()],
    );
    native
        .call(
            "capability.hosts.open",
            json!({"alias":"box","session":"broker-session"}),
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(5),
            native.call(
                "capability.hosts.close",
                json!({"session":"broker-session"})
            )
        )
        .await
        .is_err()
    );
    native.revoke().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
// R5: retirement on failure, owned close sweep, and TypeScript `host-lease.ts` parity:
// a failed open or a failed close retires only its own lease and never blocks the others.
// Scripted provider state is the provider-owned fact; handles are exact strings.
use std::collections::{HashMap, VecDeque};
enum Open {
    Handle,
    Reply(Value),
    Fail(&'static str),
}
#[derive(Default)]
struct Script {
    opens: usize,
    open: VecDeque<Open>,
    close_fail: HashMap<String, &'static str>,
    close_attempts: Vec<String>,
    closed: Vec<String>,
    drift_on_open: bool,
    run_fail: Option<&'static str>,
    fetch_fail: Option<&'static str>,
    snapshot: Option<ProviderSnapshot>,
}
type Shared = Arc<Mutex<Script>>;
struct Scripted(Shared);
fn effect(message: &str) -> BrokerError {
    BrokerError::Effect(message.into())
}
fn is_effect(result: Result<impl std::fmt::Debug, BrokerError>, message: &str) -> bool {
    matches!(result, Err(BrokerError::Effect(m)) if m == message)
}
fn is_denied<T>(result: Result<T, BrokerError>) -> bool {
    matches!(
        result,
        Err(BrokerError::Authority(AuthorityError::Denied(_)))
    )
}
impl HostProvider for Scripted {
    fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
        Some(
            self.0
                .lock()
                .unwrap()
                .snapshot
                .clone()
                .unwrap_or_else(snapshot),
        )
    }
    async fn fetch(&mut self, _: Value) -> Result<pacer_plugin_host::BundleTicket, BrokerError> {
        Err(effect(self.0.lock().unwrap().fetch_fail.unwrap()))
    }
    async fn invoke(&mut self, m: &str, p: Value) -> Result<Value, BrokerError> {
        let mut s = self.0.lock().unwrap();
        match m {
            "hostRunner.open" => {
                s.opens += 1;
                if s.drift_on_open {
                    let mut drifted = snapshot();
                    drifted.provider_generation = "changed".into();
                    s.snapshot = Some(drifted);
                }
                match s.open.pop_front().unwrap_or(Open::Handle) {
                    Open::Handle => Ok(json!({"session":h(s.opens)})),
                    Open::Reply(reply) => Ok(reply),
                    Open::Fail(message) => Err(effect(message)),
                }
            }
            "hostRunner.close" => {
                let handle = p["session"].as_str().unwrap().to_owned();
                s.close_attempts.push(handle.clone());
                if let Some(message) = s.close_fail.get(&handle) {
                    Err(effect(message))
                } else {
                    s.closed.push(handle);
                    Ok(json!({"ok":true}))
                }
            }
            _ => s.run_fail.map(|m| Err(effect(m))).unwrap_or_else(|| {
                Ok(json!({"code":0,"stdout":"ok","stderr":"","timedOut":false}))
            }),
        }
    }
}
fn scripted(edit: impl FnOnce(&mut Script)) -> (NativeHosts<Scripted>, Shared) {
    let mut script = Script::default();
    edit(&mut script);
    let shared = Arc::new(Mutex::new(script));
    (
        NativeHosts::new(Scripted(shared.clone()), [snapshot()]),
        shared,
    )
}
fn open_params(session: &str) -> Value {
    json!({"alias":"box","session":session})
}
fn run_params(session: &str) -> Value {
    json!({"session":session,"script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":1024})
}
async fn open<P: HostProvider>(
    n: &mut NativeHosts<P>,
    session: &str,
) -> Result<Value, BrokerError> {
    n.call("capability.hosts.open", open_params(session)).await
}
async fn run<P: HostProvider>(n: &mut NativeHosts<P>, session: &str) -> Result<Value, BrokerError> {
    n.call("capability.hosts.run", run_params(session)).await
}
async fn close<P: HostProvider>(
    n: &mut NativeHosts<P>,
    session: &str,
) -> Result<Value, BrokerError> {
    n.call("capability.hosts.close", json!({"session":session}))
        .await
}
fn sorted(mut handles: Vec<String>) -> Vec<String> {
    handles.sort();
    handles
}
fn h(n: usize) -> String {
    format!("provider-handle-{n:04}")
}
#[tokio::test]
async fn failed_open_retires_cleanly_then_retry_succeeds() {
    let (mut n, s) = scripted(|s| s.open.push_back(Open::Fail("boom")));
    assert!(is_effect(open(&mut n, "s1").await, "boom"));
    assert!(is_denied(run(&mut n, "s1").await));
    open(&mut n, "s2").await.unwrap();
    assert_eq!(run(&mut n, "s2").await.unwrap()["stdout"], "ok");
    n.revoke().await.unwrap();
    let s = s.lock().unwrap();
    assert_eq!(s.opens, 2);
    assert_eq!(s.close_attempts, [h(2)]);
}
#[tokio::test]
async fn invalid_open_results_are_never_closed_as_guesses() {
    // The extra-field case is excluded: native checks only `session` (D1).
    for reply in [
        json!({}),
        json!({"session":null}),
        json!({"session":7}),
        json!({"session":"a".repeat(15)}),
        json!({"session":"a".repeat(129)}),
        json!({"session":"é".repeat(9)}),
        json!([h(1)]),
        Value::Null,
        json!(h(1)),
    ] {
        let (mut n, s) = scripted(|s| s.open.push_back(Open::Reply(reply.clone())));
        assert!(is_denied(open(&mut n, "s1").await), "{reply}");
        assert!(is_denied(run(&mut n, "s1").await));
        open(&mut n, "s2").await.unwrap();
        let s = s.lock().unwrap();
        assert_eq!(s.opens, 2);
        assert!(s.close_attempts.is_empty(), "{reply}");
    }
}
#[tokio::test]
async fn failed_or_invalid_open_leaves_other_sessions_closable() {
    for failed in [Open::Fail("boom"), Open::Reply(json!({}))] {
        let (mut n, s) = scripted(|s| s.open.extend([Open::Handle, failed]));
        open(&mut n, "a").await.unwrap();
        assert!(open(&mut n, "b").await.is_err());
        assert_eq!(close(&mut n, "a").await.unwrap(), json!({"ok":true}));
        assert!(is_denied(close(&mut n, "b").await));
        let s = s.lock().unwrap();
        assert_eq!(s.close_attempts, [h(1)]);
        assert_eq!(s.closed, [h(1)]);
    }
}
#[tokio::test]
async fn failed_close_retires_that_session_and_others_stay_closable() {
    let (mut n, s) = scripted(|s| {
        s.close_fail.insert(h(1), "close A");
    });
    open(&mut n, "a").await.unwrap();
    open(&mut n, "c").await.unwrap();
    assert!(is_effect(close(&mut n, "a").await, "close A"));
    assert!(is_denied(run(&mut n, "a").await));
    assert!(is_denied(close(&mut n, "a").await));
    assert_eq!(run(&mut n, "c").await.unwrap()["stdout"], "ok");
    assert_eq!(close(&mut n, "c").await.unwrap(), json!({"ok":true}));
    open(&mut n, "d").await.unwrap();
    n.revoke().await.unwrap();
    let s = s.lock().unwrap();
    assert_eq!(s.close_attempts, [h(1), h(2), h(3)]);
    assert_eq!(s.closed, [h(2), h(3)]);
}
#[tokio::test]
async fn open_recovery_requires_exact_unchanged_snapshot() {
    for key in 0..5 {
        let (mut n, s) = scripted(|s| s.open.push_back(Open::Fail("boom")));
        assert!(is_effect(open(&mut n, "s1").await, "boom"));
        let mut changed = snapshot();
        match key {
            0 => changed.alias = "other".into(),
            1 => changed.host_fingerprint = "other".into(),
            2 => changed.caller_generation = "other".into(),
            3 => changed.provider_generation = "other".into(),
            _ => changed.provider_process = 2,
        }
        s.lock().unwrap().snapshot = Some(changed);
        assert!(is_denied(open(&mut n, "s2").await));
        assert_eq!(s.lock().unwrap().opens, 1);
        s.lock().unwrap().snapshot = None;
        open(&mut n, "s2").await.unwrap();
        assert_eq!(s.lock().unwrap().opens, 2);
    }
    let (mut n, s) = scripted(|s| s.drift_on_open = true);
    assert!(is_denied(open(&mut n, "s1").await));
    assert_eq!(s.lock().unwrap().close_attempts, [h(1)]);
    assert_eq!(s.lock().unwrap().closed, [h(1)]);
    // A failed cleanup close still retires the drifted open and blocks nothing later.
    let (mut n, s) = scripted(|s| {
        s.drift_on_open = true;
        s.close_fail.insert(h(1), "close failed");
    });
    assert!(is_denied(open(&mut n, "s1").await));
    assert!(is_denied(run(&mut n, "s1").await));
    s.lock().unwrap().drift_on_open = false;
    s.lock().unwrap().snapshot = None;
    open(&mut n, "s2").await.unwrap();
    n.revoke().await.unwrap();
    assert_eq!(s.lock().unwrap().close_attempts, [h(1), h(2)]);
}
#[tokio::test]
async fn revoke_attempts_every_session_and_returns_first_close_failure() {
    let (mut n, s) = scripted(|s| {
        s.close_fail.insert(h(1), "close A");
        s.close_fail.insert(h(2), "close B");
    });
    open(&mut n, "a").await.unwrap();
    open(&mut n, "b").await.unwrap();
    let revoked = n.revoke().await;
    let attempts = s.lock().unwrap().close_attempts.clone();
    assert_eq!(sorted(attempts.clone()), [h(1), h(2)]);
    let first = if attempts[0] == h(1) {
        "close A"
    } else {
        "close B"
    };
    assert!(is_effect(revoked, first));
    assert!(is_denied(run(&mut n, "a").await));
    n.revoke().await.unwrap();
    assert_eq!(s.lock().unwrap().close_attempts.len(), 2);
    assert!(s.lock().unwrap().closed.is_empty());
}
#[tokio::test]
async fn run_error_retires_the_exact_session_and_keeps_others() {
    let (mut n, s) = scripted(|_| {});
    open(&mut n, "a").await.unwrap();
    open(&mut n, "b").await.unwrap();
    s.lock().unwrap().run_fail = Some("run failed");
    assert!(is_effect(run(&mut n, "a").await, "run failed"));
    assert_eq!(s.lock().unwrap().closed, [h(1)]);
    s.lock().unwrap().run_fail = None;
    assert!(is_denied(run(&mut n, "a").await));
    assert_eq!(run(&mut n, "b").await.unwrap()["stdout"], "ok");
    n.revoke().await.unwrap();
    assert_eq!(s.lock().unwrap().closed, [h(1), h(2)]);
}
#[tokio::test]
async fn fetch_error_retires_the_exact_session_and_keeps_others() {
    let (mut n, s) = scripted(|s| s.fetch_fail = Some("fetch failed"));
    open(&mut n, "a").await.unwrap();
    open(&mut n, "b").await.unwrap();
    let fetch =
        json!({"session":"a","script":"BUNDLE_OUT","args":[],"timeoutMs":1000,"maxBytes":1024});
    let fetched = n.call("capability.hosts.fetch", fetch).await;
    assert!(is_effect(fetched, "fetch failed"));
    assert_eq!(s.lock().unwrap().closed, [h(1)]);
    assert!(is_denied(run(&mut n, "a").await));
    assert_eq!(run(&mut n, "b").await.unwrap()["stdout"], "ok");
}
#[tokio::test]
async fn snapshot_change_before_run_retires_with_one_provider_close() {
    let (mut n, s) = scripted(|_| {});
    open(&mut n, "a").await.unwrap();
    let mut changed = snapshot();
    changed.provider_generation = "changed".into();
    s.lock().unwrap().snapshot = Some(changed);
    assert!(is_denied(run(&mut n, "a").await));
    assert_eq!(s.lock().unwrap().close_attempts, [h(1)]);
    s.lock().unwrap().snapshot = None;
    assert!(is_denied(run(&mut n, "a").await));
    n.revoke().await.unwrap();
    assert_eq!(s.lock().unwrap().close_attempts, [h(1)]);
    assert_eq!(s.lock().unwrap().closed, [h(1)]);
}
