use super::js::{number, numeric, truthy};
use super::{V2_PROTOCOL, V3_CURSOR_BASE, is_discovery_item_id, setup};
use serde_json::{Value, json};
use std::cmp::Ordering;

fn rows(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}
fn account<'a>(s: &'a Value, e: &Value) -> Option<&'a Value> {
    rows(&s["accounts"]).find(|a| a["name"] == e["account"])
}
fn field_or(value: Option<&Value>, fallback: Value) -> Value {
    value.filter(|v| !v.is_null()).cloned().unwrap_or(fallback)
}
fn budget(s: &Value) -> Value {
    if !truthy(&s["planner"]) {
        return Value::Null;
    }
    let providers: Vec<_> = rows(&s["executors"])
        .map(|e| {
            let a = account(s, e);
            let mut p = json!({});
            if truthy(&e["eligibility"]) {
                p["eligibility"] = e["eligibility"].clone();
            }
            for key in ["id", "agent", "account", "usedPct", "pacePct"] {
                if let Some(v) = e.get(key) {
                    p[key] = v.clone();
                }
            }
            p["verdict"] = field_or(a.and_then(|a| a.get("verdict")), json!("UNKNOWN"));
            for key in ["resetsAt", "window"] {
                p[key] = field_or(a.and_then(|a| a.get(key)), Value::Null);
            }
            p["stale"] = if e["rank"] == "planner" {
                s["planner"]["stale"].clone()
            } else {
                json!(false)
            };
            for (state, key) in [("blocked", "blockedReason"), ("down", "brokenReason")] {
                if e["state"] == state
                    && let Some(v) = e
                        .get("reason")
                        .filter(|v| !v.is_null())
                        .or_else(|| e.get("sub"))
                {
                    p[key] = v.clone();
                }
            }
            p
        })
        .collect();
    let mut ranked: Vec<_> = rows(&s["executors"])
        .filter(|e| {
            e["rank"] != "planner"
                && truthy(&e["enabled"])
                && e["eligibility"]["state"] != "ineligible"
                && matches!(e["state"].as_str(), Some("ready" | "busy"))
        })
        .collect();
    ranked.sort_by(|a, b| {
        (number(&a["rank"]) - number(&b["rank"]))
            .partial_cmp(&0.0)
            .unwrap_or(Ordering::Equal)
    });
    let ranked: Vec<_> = ranked.into_iter().map(|e| json!({"id":e["id"],"verdict":field_or(account(s,e).and_then(|a| a.get("verdict")),json!("UNKNOWN"))})).collect();
    json!({"generatedAt":s["at"],"strategy":rows(&s["strategies"]).find(|v| !v.is_string() && truthy(&v["active"])).map(|v|v["name"].clone()).unwrap_or(json!("default")),"planner":s["planner"]["runner"],"mode":s["planner"]["mode"],"providers":providers,"ranked":ranked})
}

/// `legacy` carries the private V2_STATE symbol; absence derives wire fields.
/// Pure: no registration, filesystem access, or persistent state writes.
pub fn snapshot(s: &Value, legacy: Option<&Value>) -> Value {
    let mapped = setup(&s["setup"], false);
    let mut attention = Vec::new();
    for a in rows(&s["attention"]) {
        if a["id"] == "setup:connect" || is_discovery_item_id(&a["id"]) {
            continue;
        }
        let id = if a["id"] == "setup:planner" {
            json!("setup:strategy")
        } else {
            a["id"].clone()
        };
        let item = rows(&mapped["items"]).find(|i| {
            id.as_str() == Some(format!("setup:{}", i["id"].as_str().unwrap_or("")).as_str())
        });
        let mut a = a.clone();
        a["actions"] = Value::Array(
            rows(&a["actions"])
                .map(|action| {
                    let mut action = action.clone();
                    if action["op"] == "dispatch.retry" || action["op"] == "dispatch.answer" {
                        let answer = action["op"] == "dispatch.answer";
                        let mut params = json!({"view":"task","id":action["params"]["id"]});
                        if answer {
                            params["tab"] = json!("answer");
                        }
                        action["op"] = json!("ui.open");
                        action["params"] = params;
                    }
                    action
                })
                .collect(),
        );
        if let Some(item) = item {
            if item["status"] == "done" {
                continue;
            }
            a["id"] = id;
            a["title"] = item["title"].clone();
            a["actions"] = Value::Array(
                rows(&a["actions"])
                    .map(|action| {
                        let mut action = action.clone();
                        if action["op"] == "ui.open" {
                            let mut params = super::js::spread(&action["params"]);
                            params["section"] = item["id"].clone();
                            action["params"] = params;
                        }
                        action
                    })
                    .collect(),
            );
        }
        attention.push(a);
    }
    let severity = |a: &Value| match a["severity"].as_str() {
        Some("blocked") => 0,
        Some("problem") => 1,
        _ => 2,
    };
    // ICU's root collation reproduces the reference's default localeCompare.
    let collator = icu_collator::CollatorBorrowed::new_root(Default::default());
    attention.sort_by(|a, b| {
        severity(a)
            .cmp(&severity(b))
            .then_with(|| {
                number(&a["since"])
                    .partial_cmp(&number(&b["since"]))
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| {
                let a = a["id"].as_str().unwrap_or("");
                let b = b["id"].as_str().unwrap_or("");
                collator.compare(a, b)
            })
    });
    let mut out = super::object_without(s, &["desktopUpdates"]);
    out["counts"]["attention"] = json!(attention.len());
    out["counts"]["problems"] = json!(
        attention
            .iter()
            .filter(|a| a["severity"] != "decide")
            .count()
    );
    out["counts"]["setupOpen"] = mapped["open"].clone();
    out["attention"] = json!(attention);
    out["setup"] = mapped;
    if truthy(&s["machine"]["unlimited"]) {
        let cap = rows(&s["executors"])
            .filter(|e| {
                e["rank"] != "planner"
                    && e.get("host") == Some(&Value::Null)
                    && truthy(&e["enabled"])
            })
            .fold(0.0, |n, e| n + number(&e["slots"]["max"]));
        out["machine"]["max"] = numeric(cap.max(1.0));
    }
    let seq = number(&s["seq"]);
    out["seq"] = if seq >= V3_CURSOR_BASE {
        numeric(seq - V3_CURSOR_BASE)
    } else {
        s["seq"].clone()
    };
    out["v"] = json!(1);
    let legacy = legacy.filter(|v| truthy(v));
    out["budget"] = legacy
        .map(|v| v["budget"].clone())
        .unwrap_or_else(|| budget(s));
    out["alerts"] = legacy.map(|v| v["alerts"].clone()).unwrap_or_else(|| Value::Array(rows(&s["attention"]).filter(|a| !is_discovery_item_id(&a["id"])).map(|a| json!({"key":a["id"],"level":match a["severity"].as_str() {Some("blocked")=>"error",Some("problem")=>"warn",_=>"info"},"title":a["title"],"body":a["detail"],"at":a["raisedAt"]})).collect()));
    for (key, default) in [("console", Value::Null), ("consoles", json!([]))] {
        out[key] = field_or(legacy.and_then(|v| v.get(key)), default);
    }
    out["serviceInstalled"] = field_or(
        legacy.and_then(|v| v.get("serviceInstalled")),
        json!(rows(&s["setup"]["items"]).any(|i| i["id"] == "service" && i["status"] == "done")),
    );
    out["service"]["protocol"] = json!(V2_PROTOCOL);
    out
}

#[cfg(test)]
mod managed_action_tests {
    use super::*;
    #[test]
    fn managed_actions_become_navigation_and_legacy_actions_stay_intact() {
        let source = json!({"attention":[
            {"id":"question:t","severity":"blocked","actions":[{"label":"Answer","op":"dispatch.answer","params":{"id":"t","expect_rev":2,"requestId":"t.2.answer"}}]},
            {"id":"failed:t","severity":"problem","actions":[{"label":"Retry","op":"dispatch.retry","params":{"id":"t","expect_rev":2,"requestId":"t.2.retry"}}]},
            {"id":"failed:u","severity":"problem","actions":[{"label":"Retry","op":"task.retry","params":{"id":"u","executor":"codex"}}]}
        ],"setup":{"items":[]},"counts":{},"executors":[],"accounts":[],"strategies":[],"seq":0});
        let result = snapshot(&source,None);
        assert_eq!(result["attention"][0]["actions"][0],json!({"label":"Answer","op":"ui.open","params":{"view":"task","id":"t","tab":"answer"}}));
        assert_eq!(result["attention"][1]["actions"][0],json!({"label":"Retry","op":"ui.open","params":{"view":"task","id":"t"}}));
        assert_eq!(result["attention"][2]["actions"][0],source["attention"][2]["actions"][0]);
    }
}
