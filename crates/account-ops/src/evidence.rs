//! `retireEvidence` from `src/core/evidence.ts`: a lifetime boundary so delayed
//! reads cannot repopulate a removed account.
use crate::js::stringify;
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use serde_json::{Value, json};

fn finite(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}

fn nullable_finite(v: Option<&Value>) -> bool {
    v.is_some_and(|v| v.is_null() || finite(v))
}

fn facts_valid(facts: &Value, identity: &str, account: &str) -> bool {
    let lists = ["availability", "budget", "spending"].map(|k| facts.get(k));
    let fact_ok = |f: &Value| {
        f.is_object()
            && f["id"].is_string()
            && f["scope"]["identity"] == identity
            && f["scope"]["account"] == account
            && f["source"].is_string()
            && f["reason"].is_string()
            && nullable_finite(f.get("observedAt"))
            && nullable_finite(f.get("validUntil"))
    };
    let all = |list: Option<&Value>, ok: &dyn Fn(&Value) -> bool| {
        list.and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(ok))
    };
    if !lists.iter().all(|list| all(*list, &fact_ok)) {
        return false;
    }
    let availability = |f: &Value| {
        f["value"]
            .as_str()
            .is_some_and(|v| ["ready", "unavailable", "unknown"].contains(&v))
    };
    let budget = |f: &Value| {
        let w = &f["value"];
        w.is_object()
            && w["name"].is_string()
            && (w["usedPct"].is_null() && w.get("usedPct").is_some()
                || w["usedPct"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.0))
            && nullable_finite(w.get("resetsAt"))
            && w["lengthS"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
            && w["paced"].is_boolean()
    };
    let spending = |f: &Value| {
        let v = &f["value"];
        v.is_object()
            && v["paidConsumption"]
                .as_str()
                .is_some_and(|p| ["observed", "unknown", "not_observed"].contains(&p))
            && v.get("creditsAvailable")
                .is_some_and(|c| c.is_null() || c.is_boolean())
            && nullable_finite(v.get("creditBalance"))
    };
    all(lists[0], &availability) && all(lists[1], &budget) && all(lists[2], &spending)
}

/// `readEvidence`: the saved snapshot, or `None` where TypeScript starts from an empty one.
fn read(ctx: &Ctx, identity: &str, account: &str) -> Option<Value> {
    let path = ctx
        .pacer_home
        .join("state/evidence")
        .join(format!("{identity}.json"));
    let saved: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let revision = saved["revision"].as_f64()?;
    let valid = saved["version"].as_f64() == Some(1.0)
        && saved["identity"] == identity
        && revision.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&revision)
        && saved["evidence"].is_object()
        && saved["evidence"]["conflicts"].is_array()
        && facts_valid(&saved["evidence"]["facts"], identity, account);
    valid.then_some(saved)
}

/// JavaScript `Number(value)` for the values a JSON document can hold.
fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = pacer_foundation::js_semantics::js_trim(s);
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

pub(crate) fn retire(ctx: &Ctx, identity: &str, account: &str) -> Result<(), String> {
    with_lock(
        ctx,
        &format!("evidence-{identity}"),
        LockOptions::default(),
        || {
            let previous = read(ctx, identity, account);
            let revision = previous
                .as_ref()
                .and_then(|p| p["revision"].as_f64())
                .unwrap_or(0.0);
            let prior = previous
                .as_ref()
                .and_then(|p| p.get("retiredAt"))
                .map_or(0.0, to_number);
            let retired = if prior.is_nan() {
                f64::NAN
            } else {
                ctx.now.max(prior)
            };
            let next = json!({
                "version": 1,
                "identity": identity,
                "revision": revision + 1.0,
                "retiredAt": retired,
                "evidence": {"facts": {"availability": [], "budget": [], "spending": []}, "conflicts": []},
            });
            let path = ctx
                .pacer_home
                .join("state/evidence")
                .join(format!("{identity}.json"));
            pacer_foundation::fsutil::write_private(&path, stringify(&next, 0).as_bytes())
                .map_err(|e| e.to_string())
        },
    )
    .map_err(|e| e.to_string())?
}
