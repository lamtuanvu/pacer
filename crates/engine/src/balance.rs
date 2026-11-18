//! `balanceByLoad` from `src/engine/balance.ts`: with `pacing.balance: least-loaded`, each
//! run of adjacent, equally budget-acceptable ranked candidates is reordered by load.
use crate::{number, string, yielded};
use serde_json::Value;

/// `utilization`: tasks running on an executor over its own slot limit.
pub fn utilization(used: usize, limit: usize) -> f64 {
    if limit == 0 {
        return if used > 0 { f64::INFINITY } else { 0.0 };
    }
    used as f64 / limit as f64
}

/// `verdictTier`: EXPIRING first, NEAR_LIMIT behind the normal band, AHEAD last.
fn verdict_tier(verdict: &Value) -> u8 {
    match string(verdict) {
        "EXPIRING" => 0,
        "NEAR_LIMIT" => 2,
        "AHEAD" => 3,
        _ => 1,
    }
}

/// `TIER[statuses[id]?.usage ?? "quota"] ?? 99`.
fn usage_tier(usage: &Value) -> u8 {
    match usage {
        Value::Null => 1,
        Value::String(kind) => match kind.as_str() {
            "unmetered" => 0,
            "quota" | "reactive" => 1,
            "metered" => 2,
            _ => 99,
        },
        _ => 99,
    }
}

/// Stable-sorts each band of `ranked` (same uncertainty, verdict tier, fill yield and, under
/// `cheapest-first`, usage tier) by `used / limit`, ties keeping the policy order, and appends
/// ` · load used/limit` to every member of a band of two or more. `use_` is a `SlotUse`
/// (`byExecutor` counts); `limit` is `slotLimit(s, id).executor`; `statuses` maps provider ids
/// to their status rows. Any other `pacing.balance` returns `ranked` unchanged.
pub fn balance_by_load(
    ranked: &[Value],
    strategy: &Value,
    use_: &Value,
    statuses: &Value,
    limit: impl Fn(&str) -> usize,
) -> Vec<Value> {
    let pacing = &strategy["pacing"];
    if pacing["balance"] != "least-loaded" {
        return ranked.to_vec();
    }
    let fill = pacing["accounts"] == "fill";
    let cheapest = pacing["policy"] == "cheapest-first";
    let threshold = number(&pacing["fillThreshold"]);
    let band_key = |entry: &Value| {
        let status = statuses.get(string(&entry["id"])).unwrap_or(&Value::Null);
        (
            entry["fallback"] == "uncertain",
            verdict_tier(&entry["verdict"]),
            fill && !status.is_null() && yielded(status, threshold),
            if cheapest {
                usage_tier(&status["usage"])
            } else {
                0
            },
        )
    };
    let used = |id: &str| use_["byExecutor"][id].as_u64().unwrap_or(0) as usize;
    let keys: Vec<_> = ranked.iter().map(band_key).collect();
    let mut out = ranked.to_vec();
    let mut start = 0;
    for end in 1..=ranked.len() {
        if end < ranked.len() && keys[end] == keys[start] {
            continue;
        }
        if end - start > 1 {
            let mut band: Vec<(&Value, usize, f64)> = ranked[start..end]
                .iter()
                .enumerate()
                .map(|(j, e)| {
                    let id = string(&e["id"]);
                    (e, j, utilization(used(id), limit(id)))
                })
                .collect();
            band.sort_by(|x, y| x.2.total_cmp(&y.2).then(x.1.cmp(&y.1)));
            for (k, (entry, _, _)) in band.into_iter().enumerate() {
                let id = string(&entry["id"]);
                let load = format!(" · load {}/{}", used(id), limit(id));
                let mut entry = entry.clone();
                if !string(&entry["reason"]).ends_with(&load) {
                    entry["reason"] = Value::String(format!("{}{load}", string(&entry["reason"])));
                }
                out[start + k] = entry;
            }
        }
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    fn ids(ranked: &[Value]) -> Vec<&str> {
        ranked.iter().map(|e| string(&e["id"])).collect()
    }

    fn entry(id: &str, verdict: &str) -> Value {
        json!({"id": id, "score": 1, "verdict": verdict, "reason": "on pace"})
    }

    fn strategy(balance: &str, accounts: &str, policy: &str) -> Value {
        json!({"pacing": {"balance": balance, "accounts": accounts, "policy": policy, "fillThreshold": 80}})
    }

    #[test]
    fn spreads_a_band_by_load_and_keeps_bands_in_place() {
        let ranked = [
            entry("a", "ON_PACE"),
            entry("b", "BEHIND"),
            entry("c", "UNKNOWN"),
            entry("d", "AHEAD"),
        ];
        let use_ = json!({"byExecutor": {"a": 2, "b": 1}, "byHost": {}, "local": 3});
        let limits = |id: &str| if id == "a" { 4 } else { 1 };
        let out = balance_by_load(
            &ranked,
            &strategy("least-loaded", "spread", "priority"),
            &use_,
            &json!({}),
            limits,
        );
        assert_eq!(ids(&out), ["c", "a", "b", "d"]);
        assert_eq!(out[0]["reason"], "on pace · load 0/1");
        assert_eq!(out[1]["reason"], "on pace · load 2/4");
        assert_eq!(out[3]["reason"], "on pace");
        let again = balance_by_load(
            &out,
            &strategy("least-loaded", "spread", "priority"),
            &use_,
            &json!({}),
            limits,
        );
        assert_eq!(again, out);
    }

    #[test]
    fn off_uncertain_fill_and_cheapest_split_bands() {
        let ranked = [entry("a", "ON_PACE"), entry("b", "ON_PACE")];
        let use_ = json!({"byExecutor": {"a": 1}});
        let off = balance_by_load(
            &ranked,
            &strategy("off", "spread", "priority"),
            &use_,
            &json!({}),
            |_| 1,
        );
        assert_eq!(off, ranked);
        let mut uncertain = ranked.clone();
        uncertain[0]["fallback"] = json!("uncertain");
        let s = strategy("least-loaded", "spread", "priority");
        assert_eq!(
            ids(&balance_by_load(&uncertain, &s, &use_, &json!({}), |_| 1)),
            ["a", "b"]
        );
        let statuses = json!({"a": {"windows": [{"verdict": "ON_PACE", "usedPct": 90}], "usage": "metered"}, "b": {"windows": []}});
        let fill = strategy("least-loaded", "fill", "priority");
        assert_eq!(
            ids(&balance_by_load(&ranked, &fill, &use_, &statuses, |_| 1)),
            ["a", "b"]
        );
        let cheapest = strategy("least-loaded", "spread", "cheapest-first");
        assert_eq!(
            ids(&balance_by_load(
                &ranked,
                &cheapest,
                &use_,
                &statuses,
                |_| 1
            )),
            ["a", "b"]
        );
        assert_eq!(
            ids(&balance_by_load(&ranked, &s, &use_, &statuses, |_| 1)),
            ["b", "a"]
        );
    }

    #[test]
    fn a_zero_limit_sorts_busy_executors_last() {
        assert_eq!(utilization(0, 0), 0.0);
        assert_eq!(utilization(1, 0), f64::INFINITY);
        let ranked = [entry("a", "ON_PACE"), entry("b", "ON_PACE")];
        let out = balance_by_load(
            &ranked,
            &strategy("least-loaded", "spread", "priority"),
            &json!({"byExecutor": {"a": 1, "b": 3}}),
            &json!({}),
            |id| if id == "a" { 0 } else { 5 },
        );
        assert_eq!(ids(&out), ["b", "a"]);
        assert_eq!(out[1]["reason"], "on pace · load 1/0");
    }
}
