//! Aggregate policy budget and final-context receipts. No effects run under a stale receipt.
use crate::{AuthorityError, BrokerError};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
#[derive(Clone, serde::Serialize)]
pub struct PolicyEntry {
    pub id: String,
    pub generation: String,
}
#[derive(serde::Serialize)]
pub struct PolicySnapshot {
    pub closed: bool,
    pub fingerprint: String,
    pub policies: Vec<PolicyEntry>,
    pub unavailable: Vec<(String, String)>,
}
pub trait PolicyCaller {
    fn call(
        &mut self,
        id: &str,
        params: Value,
        deadline: Instant,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
    fn failure(&mut self, _id: &str, _reason: &str) {}
    fn veto(&mut self, _id: &str, _reason: &str) {}
}
#[derive(Default)]
pub struct PolicyOptions<'a> {
    pub eligible_runners: &'a [String],
    pub allowed_placements: &'a [String],
    pub validate_delegate: Option<&'a dyn Fn(&Value) -> bool>,
    pub operation_deadline: Option<Instant>,
    pub cancellation: Option<PolicyCancellation>,
    /// Fresh metadata and operation context, independent of lazy process startup.
    pub current_fingerprint: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}
#[derive(Debug)]
pub struct PolicyReceipt {
    pub params: Value,
    pub excluded_by: HashMap<String, String>,
    fingerprint: String,
    operation_deadline: Option<Instant>,
    cancellation: Option<PolicyCancellation>,
}
#[derive(Clone, Default, Debug)]
pub struct PolicyCancellation(Arc<(AtomicBool, tokio::sync::Notify)>);
impl PolicyCancellation {
    pub fn cancel(&self) {
        self.0.0.store(true, Ordering::SeqCst);
        self.0.1.notify_waiters();
    }
    fn check(&self) -> Result<(), BrokerError> {
        if self.0.0.load(Ordering::SeqCst) {
            return Err(veto("Policy operation cancelled"));
        }
        Ok(())
    }
    async fn cancelled(&self) {
        loop {
            let notified = self.0.1.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.0.0.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}
fn check(options: &PolicyOptions<'_>, fingerprint: &str) -> Result<(), BrokerError> {
    if let Some(cancel) = &options.cancellation {
        cancel.check()?;
    }
    if options
        .current_fingerprint
        .as_ref()
        .is_some_and(|current| current() != fingerprint)
    {
        return Err(BrokerError::Effect("Policy context changed".into()));
    }
    Ok(())
}
fn veto(reason: &str) -> BrokerError {
    AuthorityError::Denied(reason.into()).into()
}
impl PolicyReceipt {
    pub fn revalidate(&self, current: &str) -> Result<(), BrokerError> {
        if let Some(cancel) = &self.cancellation {
            cancel.check()?;
        }
        if current != self.fingerprint {
            return Err(BrokerError::Effect("Policy context changed".into()));
        }
        if self.operation_deadline.is_some_and(|d| Instant::now() >= d) {
            return Err(veto("Policy operation deadline expired"));
        }
        Ok(())
    }
}
pub async fn evaluate_policy<C: PolicyCaller>(
    snapshot: PolicySnapshot,
    input: Value,
    caller: &mut C,
    budget: Instant,
) -> Result<PolicyReceipt, BrokerError> {
    evaluate_policy_with(snapshot, input, caller, budget, PolicyOptions::default()).await
}
pub async fn evaluate_policy_with<C: PolicyCaller>(
    mut snapshot: PolicySnapshot,
    mut params: Value,
    caller: &mut C,
    budget: Instant,
    options: PolicyOptions<'_>,
) -> Result<PolicyReceipt, BrokerError> {
    if snapshot.fingerprint.is_empty() {
        return Err(BrokerError::Invalid("policy snapshot"));
    }
    validate_input(&params)?;
    bounded(
        &serde_json::to_value(&snapshot).map_err(|_| BrokerError::Invalid("policy snapshot"))?,
    )?;
    if snapshot.unavailable.iter().any(|(id, _)| id.is_empty()) {
        return Err(BrokerError::Invalid("policy snapshot"));
    }
    let mut ids = HashSet::new();
    for p in &snapshot.policies {
        if p.id.is_empty()
            || crate::js_semantics::utf16_len(&p.id) > 128
            || p.generation.is_empty()
            || !ids.insert(p.id.clone())
        {
            return Err(BrokerError::Invalid("policy identity"));
        }
    }
    snapshot
        .policies
        .sort_by(|a, b| a.id.encode_utf16().cmp(b.id.encode_utf16()));
    for (id, reason) in &snapshot.unavailable {
        if snapshot.closed {
            return Err(veto(&format!(
                "Granted plugin {id} cannot be verified ({reason})"
            )));
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            caller.failure(id, "Granted plugin cannot be verified")
        }));
    }
    let aggregate = budget
        .min(Instant::now() + Duration::from_secs(10))
        .min(options.operation_deadline.unwrap_or(budget));
    let mut excluded_by = HashMap::new();
    for policy in &snapshot.policies {
        check(&options, &snapshot.fingerprint)?;
        let deadline = aggregate.min(Instant::now() + Duration::from_secs(3));
        let result = if Instant::now() >= deadline {
            Err(BrokerError::Timeout)
        } else if let Err(error) = bounded(&params) {
            Err(error)
        } else {
            let invoke = tokio::time::timeout_at(
                deadline.into(),
                caller.call(&policy.id, params.clone(), deadline),
            );
            if let Some(cancel) = &options.cancellation {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => { return Err(veto("Policy operation cancelled")); }
                    reply = invoke => reply.map_err(|_|BrokerError::Timeout).and_then(|r|r),
                }
            } else {
                invoke
                    .await
                    .map_err(|_| BrokerError::Timeout)
                    .and_then(|r| r)
            }
        };
        check(&options, &snapshot.fingerprint)?;
        let amended = match result {
            Ok(verdict) => bounded(&verdict).and_then(|()| {
                apply_verdict(&params, &verdict, &options, &mut excluded_by, &policy.id)
            }),
            Err(BrokerError::PolicyKey) => {
                return Err(veto("Policy hash key cannot be accessed safely"));
            }
            Err(error) => Err(error),
        };
        match amended {
            Ok(Some(next)) => params = next,
            Ok(None) => {}
            Err(BrokerError::PolicyVeto(reason)) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    caller.veto(&policy.id, &reason)
                }));
                return Err(veto(&reason));
            }
            Err(_) if snapshot.closed => return Err(veto("Policy decision failed")),
            Err(_) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    caller.failure(
                        &policy.id,
                        "Policy decision failed and was ignored in open mode",
                    )
                }));
            }
        }
    }
    check(&options, &snapshot.fingerprint)?;
    Ok(PolicyReceipt {
        params,
        excluded_by,
        fingerprint: snapshot.fingerprint,
        operation_deadline: options.operation_deadline,
        cancellation: options.cancellation,
    })
}
fn apply_verdict(
    params: &Value,
    verdict: &Value,
    options: &PolicyOptions<'_>,
    excluded: &mut HashMap<String, String>,
    id: &str,
) -> Result<Option<Value>, BrokerError> {
    let object = verdict
        .as_object()
        .ok_or(BrokerError::Invalid("policy verdict"))?;
    let action = verdict["verdict"]
        .as_str()
        .ok_or(BrokerError::Invalid("policy verdict"))?;
    if object
        .keys()
        .any(|k| !["verdict", "reason", "amend"].contains(&k.as_str()))
        || verdict.get("reason").is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| crate::js_semantics::codepoint_len(s) > 512)
        })
    {
        return Err(BrokerError::Invalid("policy verdict"));
    }
    match action {
        "veto" if !object.contains_key("amend") => {
            return Err(BrokerError::PolicyVeto(
                verdict["reason"]
                    .as_str()
                    .unwrap_or("Policy vetoed decision")
                    .into(),
            ));
        }
        "allow" if !object.contains_key("amend") => return Ok(None),
        "amend" => {}
        _ => return Err(BrokerError::Invalid("policy verdict")),
    }
    let amend = verdict["amend"]
        .as_object()
        .ok_or(BrokerError::Invalid("policy amendment"))?;
    let mut next = params.clone();
    match params["decision"].as_str() {
        Some("review") => return Err(BrokerError::Invalid("Review amendments are forbidden")),
        Some("route") => {
            if amend.len() != 1 {
                return Err(BrokerError::Invalid("route amendment"));
            }
            let candidates = params["input"]["candidates"]
                .as_array()
                .ok_or(BrokerError::Invalid("route candidates"))?;
            let remove = amend
                .get("exclude")
                .and_then(Value::as_array)
                .ok_or(BrokerError::Invalid("route exclusions"))?;
            if remove
                .iter()
                .any(|v| v.as_str().is_none_or(|s| !valid_id(s)) || !candidates.contains(v))
            {
                return Err(BrokerError::Invalid("Unknown candidate exclusion"));
            }
            next["input"]["candidates"] = json!(
                candidates
                    .iter()
                    .filter(|v| !remove.contains(v))
                    .collect::<Vec<_>>()
            );
            for value in remove {
                if let Some(key) = value.as_str() {
                    excluded.insert(key.into(), id.into());
                }
            }
        }
        Some("delegate") => {
            if amend
                .keys()
                .any(|k| !["kind", "requestedExecutor", "placement"].contains(&k.as_str()))
            {
                return Err(BrokerError::Invalid("delegate amendment"));
            }
            if let Some(executor) = amend.get("requestedExecutor")
                && (executor != &params["input"]["requestedExecutor"]
                    || (!executor.is_null()
                        && executor
                            .as_str()
                            .is_none_or(|s| !options.eligible_runners.iter().any(|r| r == s))))
            {
                return Err(BrokerError::Invalid("Executor amendments are refused"));
            }
            if let Some(placement) = amend.get("placement")
                && ((placement != &params["input"]["placement"] && placement != "new")
                    || placement
                        .as_str()
                        .is_none_or(|s| !options.allowed_placements.iter().any(|p| p == s)))
            {
                return Err(BrokerError::Invalid("Placement amendment is not eligible"));
            }
            if amend.get("kind").is_some_and(|v| {
                !v.is_null()
                    && v.as_str().is_none_or(|s| {
                        ![
                            "boilerplate",
                            "tests",
                            "docs",
                            "rename",
                            "migration",
                            "feature",
                            "debug",
                            "refactor",
                            "performance",
                            "unfamiliar-code",
                            "research",
                        ]
                        .contains(&s)
                    })
            }) {
                return Err(BrokerError::Invalid("kind amendment"));
            }
            for (key, value) in amend {
                next["input"][key] = value.clone();
            }
            if next != *params
                && options
                    .validate_delegate
                    .is_none_or(|validate| !validate(&next["input"]))
            {
                return Err(BrokerError::Invalid("Delegate amendment is not eligible"));
            }
            validate_input(&next)?;
        }
        _ => return Err(BrokerError::Invalid("policy decision")),
    }
    Ok(Some(next))
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && crate::js_semantics::codepoint_len(s) <= 128
}
fn bounded(value: &Value) -> Result<(), BrokerError> {
    if crate::js_canonical_json(value)?.len() > 1024 * 1024 {
        return Err(BrokerError::Invalid(
            "Policy decision exceeds transport limit",
        ));
    }
    Ok(())
}
fn validate_input(params: &Value) -> Result<(), BrokerError> {
    let decision = params["decision"]
        .as_str()
        .ok_or(BrokerError::Invalid("policy decision"))?;
    let p = params["input"]
        .as_object()
        .ok_or(BrokerError::Invalid("policy input"))?;
    if params.as_object().is_none_or(|o| o.len() != 2) {
        return Err(BrokerError::Invalid("policy envelope"));
    }
    let allowed: &[&str] = match decision {
        "delegate" => &[
            "goal",
            "repo",
            "goalLength",
            "goalHash",
            "repoKey",
            "kind",
            "requestedExecutor",
            "placement",
        ],
        "route" => &["taskId", "candidates"],
        "review" => &[
            "taskId",
            "revision",
            "state",
            "verdict",
            "note",
            "noteLength",
            "noteHash",
            "kind",
            "executor",
        ],
        _ => return Err(BrokerError::Invalid("policy decision")),
    };
    if p.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(BrokerError::Invalid("policy field"));
    }
    let string = |key: &str, min: usize, max: usize| {
        p.get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| (min..=max).contains(&crate::js_semantics::codepoint_len(s)))
    };
    for key in ["goalLength", "noteLength"] {
        if p.get(key)
            .is_some_and(|v| crate::js_semantics::safe_u64(v).is_none())
        {
            return Err(BrokerError::Invalid("policy length metadata"));
        }
    }
    for key in ["goalHash", "repoKey", "noteHash"] {
        if p.get(key).is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| crate::js_semantics::codepoint_len(s) != 64)
        }) {
            return Err(BrokerError::Invalid("policy hash metadata"));
        }
    }
    const KINDS: &[&str] = &[
        "boilerplate",
        "tests",
        "docs",
        "rename",
        "migration",
        "feature",
        "debug",
        "refactor",
        "performance",
        "unfamiliar-code",
        "research",
    ];
    if decision == "review"
        && (p
            .get("kind")
            .is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !KINDS.contains(&s)))
            || p.get("executor")
                .is_some_and(|v| v.as_str().is_none_or(|s| !valid_id(s))))
    {
        return Err(BrokerError::Invalid("policy review metadata"));
    }
    let valid = match decision {
        "delegate" => {
            string("goal", 0, 200_000)
                && string("repo", 1, 4096)
                && p.get("kind")
                    .is_some_and(|v| v.is_null() || v.as_str().is_some_and(valid_id))
                && p.get("requestedExecutor")
                    .is_some_and(|v| v.is_null() || v.as_str().is_some_and(valid_id))
                && p.get("placement")
                    .and_then(Value::as_str)
                    .is_some_and(|s| ["current", "new", "auto"].contains(&s))
        }
        "route" => {
            string("taskId", 1, 128)
                && p.get("candidates")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().all(|v| v.as_str().is_some_and(valid_id)))
        }
        "review" => {
            string("taskId", 1, 128)
                && p.get("revision")
                    .and_then(crate::js_semantics::safe_u64)
                    .is_some()
                && p.get("state").and_then(Value::as_str).is_some_and(|s| {
                    [
                        "queued",
                        "running",
                        "done",
                        "partial",
                        "failed",
                        "limit",
                        "stopped",
                        "needs_input",
                    ]
                    .contains(&s)
                })
                && p.get("verdict")
                    .and_then(Value::as_str)
                    .is_some_and(|s| ["accept", "reject", "send_back", "retry"].contains(&s))
                && (!p.contains_key("note") || string("note", 0, 4096))
        }
        _ => false,
    };
    if !valid {
        return Err(BrokerError::Invalid("policy input"));
    }
    Ok(())
}
