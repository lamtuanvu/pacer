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
// R5: failed-open settlement, owned retirement sweep and first sticky cause.
// Scripted provider state is the provider-owned fact; handles are exact strings.
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    task::{Context, Poll, Waker},
};
enum Open {
    Handle,
    Reply(Value),
    Fail(&'static str),
}
enum Settle {
    Fail(&'static str),
    Pend,
}
#[derive(Default)]
struct Script {
    opens: usize,
    settles: usize,
    open: VecDeque<Open>,
    settle: VecDeque<Settle>,
    close_fail: HashMap<String, &'static str>,
    close_pend: usize,
    close_attempts: Vec<String>,
    closed: Vec<String>,
    drift_on_open: bool,
    run_fail: Option<&'static str>,
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
    async fn invoke(&mut self, m: &str, p: Value) -> Result<Value, BrokerError> {
        // `None` pends forever; the guard is released before any await.
        let reply = {
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
                        Open::Handle => Some(Ok(
                            json!({"session":format!("provider-handle-{:04}",s.opens)}),
                        )),
                        Open::Reply(reply) => Some(Ok(reply)),
                        Open::Fail(message) => Some(Err(effect(message))),
                    }
                }
                "hostRunner.close" => {
                    let handle = p["session"].as_str().unwrap().to_owned();
                    s.close_attempts.push(handle.clone());
                    if s.close_pend > 0 {
                        s.close_pend -= 1;
                        None
                    } else if let Some(message) = s.close_fail.get(&handle) {
                        Some(Err(effect(message)))
                    } else {
                        s.closed.push(handle);
                        Some(Ok(json!({"ok":true})))
                    }
                }
                _ => Some(s.run_fail.map(|m| Err(effect(m))).unwrap_or_else(|| {
                    Ok(json!({"code":0,"stdout":"ok","stderr":"","timedOut":false}))
                })),
            }
        };
        match reply {
            Some(reply) => reply,
            None => std::future::pending().await,
        }
    }
    async fn retire_pending(&mut self) -> Result<(), BrokerError> {
        let next = {
            let mut s = self.0.lock().unwrap();
            s.settles += 1;
            s.settle.pop_front()
        };
        match next {
            None => Ok(()),
            Some(Settle::Fail(message)) => Err(effect(message)),
            Some(Settle::Pend) => std::future::pending().await,
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
/// One deterministic poll with a no-op waker; the future is dropped on return.
fn poll_once<F: Future>(future: F) -> Poll<F::Output> {
    let mut future = std::pin::pin!(future);
    future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
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
fn sorted(mut handles: Vec<String>) -> Vec<String> {
    handles.sort();
    handles
}
fn h(n: usize) -> String {
    format!("provider-handle-{n:04}")
}
#[tokio::test]
async fn settled_open_error_is_settled_then_retry_succeeds() {
    let (mut n, s) = scripted(|s| s.open.push_back(Open::Fail("boom")));
    assert!(is_effect(open(&mut n, "s1").await, "boom"));
    assert_eq!(s.lock().unwrap().settles, 1);
    assert!(s.lock().unwrap().close_attempts.is_empty());
    open(&mut n, "s2").await.unwrap();
    assert_eq!(run(&mut n, "s2").await.unwrap()["stdout"], "ok");
    let s = s.lock().unwrap();
    assert_eq!((s.opens, s.settles), (2, 1));
    assert!(s.close_attempts.is_empty());
}
#[tokio::test]
async fn settled_invalid_open_results_are_settled_never_closed_as_guesses() {
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
        assert_eq!(s.lock().unwrap().settles, 1);
        assert!(is_denied(run(&mut n, "s1").await));
        open(&mut n, "s2").await.unwrap();
        let s = s.lock().unwrap();
        assert_eq!((s.opens, s.settles), (2, 1));
        assert!(s.close_attempts.is_empty(), "{reply}");
    }
}
#[tokio::test]
async fn default_provider_cannot_certify_settled_open_failure() {
    struct Legacy(Arc<AtomicUsize>);
    impl HostProvider for Legacy {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(snapshot())
        }
        async fn invoke(&mut self, _: &str, _: Value) -> Result<Value, BrokerError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(effect("boom"))
        }
    }
    let opens = Arc::new(AtomicUsize::new(0));
    let mut n = NativeHosts::new(Legacy(opens.clone()), [snapshot()]);
    let unverified = "pending host open cleanup unverified";
    assert!(is_effect(open(&mut n, "s1").await, "boom"));
    assert!(is_effect(open(&mut n, "s2").await, unverified));
    assert!(is_effect(run(&mut n, "s1").await, unverified));
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert!(is_effect(n.revoke().await, unverified));
    assert!(is_effect(n.revoke().await, unverified));
}
#[tokio::test]
async fn failed_settlement_keeps_operation_cause_and_sticky_uncertainty() {
    let (mut n, s) = scripted(|s| {
        s.open.push_back(Open::Fail("boom"));
        s.settle.push_back(Settle::Fail("settle failed"));
    });
    assert!(is_effect(open(&mut n, "s1").await, "boom"));
    assert!(is_effect(open(&mut n, "s2").await, "settle failed"));
    assert!(is_effect(run(&mut n, "s1").await, "settle failed"));
    let close = n.call("capability.hosts.close", json!({"session":"s1"}));
    assert!(is_effect(close.await, "settle failed"));
    assert!(is_effect(n.revoke().await, "settle failed"));
    assert!(is_effect(n.revoke().await, "settle failed"));
    let s = s.lock().unwrap();
    assert_eq!((s.opens, s.settles), (1, 1));
    assert!(s.close_attempts.is_empty());
}
#[tokio::test]
async fn cancel_during_open_settlement_retains_pending_marker() {
    let (mut n, s) = scripted(|s| {
        s.open.push_back(Open::Fail("boom"));
        s.settle.push_back(Settle::Pend);
    });
    assert!(poll_once(open(&mut n, "s1")).is_pending());
    assert_eq!(s.lock().unwrap().settles, 1);
    assert!(is_denied(open(&mut n, "s2").await));
    assert_eq!(s.lock().unwrap().opens, 1);
    assert_eq!(s.lock().unwrap().settles, 1);
    n.revoke().await.unwrap();
    assert_eq!(s.lock().unwrap().settles, 2);
}
#[tokio::test]
async fn settled_failure_recovery_requires_exact_unchanged_snapshot() {
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
    let (mut n, s) = scripted(|s| {
        s.drift_on_open = true;
        s.close_fail.insert(h(1), "close failed");
    });
    assert!(is_effect(open(&mut n, "s1").await, "close failed"));
    s.lock().unwrap().snapshot = None;
    assert!(is_effect(open(&mut n, "s2").await, "close failed"));
    assert_eq!(s.lock().unwrap().close_attempts, [h(1)]);
}
#[tokio::test]
async fn revoke_attempts_every_session_and_keeps_first_cause() {
    // (a) A pre-existing sticky cause wins over a later close failure.
    let (mut n, s) = scripted(|s| {
        s.open
            .extend([Open::Handle, Open::Handle, Open::Fail("boom")]);
        s.settle.push_back(Settle::Fail("settle failed"));
        s.close_fail.insert(h(1), "close A");
    });
    open(&mut n, "a").await.unwrap();
    open(&mut n, "b").await.unwrap();
    assert!(is_effect(open(&mut n, "c").await, "boom"));
    assert_eq!(s.lock().unwrap().settles, 1);
    assert!(is_effect(n.revoke().await, "settle failed"));
    assert_eq!(
        sorted(s.lock().unwrap().close_attempts.clone()),
        [h(1), h(2)]
    );
    assert_eq!(s.lock().unwrap().closed, [h(2)]);
    assert!(is_effect(n.revoke().await, "settle failed"));
    assert_eq!(
        sorted(s.lock().unwrap().close_attempts.clone()),
        [h(1), h(1), h(2)]
    );
    assert_eq!(s.lock().unwrap().closed, [h(2)]);
    assert_eq!(s.lock().unwrap().settles, 1);
    // (b) Without a prior cause, the first observed close failure wins.
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
    assert!(is_effect(run(&mut n, "a").await, first));
    assert!(is_effect(n.revoke().await, first));
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
