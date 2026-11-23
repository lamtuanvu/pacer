//! Evidence reconcile and merge, ported from `src/engine/evidence.ts` and
//! `src/core/evidence.ts` (B12-1).

use pacer_foundation::Ctx;
use pacer_foundation::api::CoreError;
use serde_json::{Value, json};

/// `emptyEvidence` (evidence.ts): `{"availability":[],"budget":[],"spending":[]}`.
pub fn empty_evidence() -> Value {
    json!({"availability": [], "budget": [], "spending": []})
}

/// `accountEvidenceScope(account, hosts)` (src/evidence/scope.ts): `{account, identity}`.
pub fn account_scope(_account: &Value, _hosts: &Value) -> Value {
    Value::Null
}

/// `evidenceFact` (evidence.ts:7-11).
pub fn evidence_fact(
    _scope: &Value,
    _source: &str,
    _observed_at: Option<f64>,
    _valid_until: Option<f64>,
    _reason: &str,
    _value: Value,
    _budget_policy: Option<&str>,
) -> Value {
    Value::Null
}

/// `appliesTo` (evidence.ts:12-15).
pub fn applies_to(_fact: &Value, _scope: &Value) -> bool {
    false
}

/// `currentEvidence` (evidence.ts:29-31).
pub fn current_evidence(_fact: &Value, _now: f64, _deadline: Option<Option<f64>>) -> bool {
    false
}

/// `evidenceDeadline`: re-export of `pacer_engine::deadline`.
pub fn evidence_deadline(_fact: &Value) -> Option<f64> {
    None
}

/// `reconcileEvidence` (evidence.ts:73-138).
pub fn reconcile_evidence(
    _previous: &Value,
    _incoming: &Value,
    _now: f64,
    _budget_policy: Option<&str>,
) -> Value {
    Value::Null
}

/// `readingEvidence` (evidence.ts:141-161).
pub fn reading_evidence(_scope: &Value, _reading: &Value, _usage: &str) -> Value {
    Value::Null
}

/// `readEvidence` (core/evidence.ts:17-36).
pub fn read_evidence(_ctx: &Ctx, _scope: &Value) -> Value {
    Value::Null
}

/// `mergeEvidence` (core/evidence.ts:38-60).
pub async fn merge_evidence(
    _ctx: &Ctx,
    _scope: &Value,
    _incoming: &Value,
    _budget_policy: Option<&str>,
    _read_only: bool,
) -> Result<Value, CoreError> {
    Ok(Value::Null)
}
