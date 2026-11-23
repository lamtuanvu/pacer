use super::{
    agents::{agent_info, runner_agent},
    selectors::{counts, planner_meter},
};
use serde_json::{Value, json};
fn coalesce(values: &[&Value]) -> Value {
    values
        .iter()
        .find(|v| !v.is_null())
        .map_or(Value::Null, |v| (*v).clone())
}
fn count(n: &Value) -> Value {
    if n.as_f64().is_some_and(|n| n >= 0.0 && n.fract() == 0.0) {
        n.clone()
    } else {
        Value::Null
    }
}
/// Match TypeScript JSON: whole meters serialize as integers, not `100.0`.
fn json_meter(n: f64) -> Value {
    if n.is_finite() && (n - n.round()).abs() < f64::EPSILON {
        Value::Number(serde_json::Number::from(n.round() as i64))
    } else {
        json!(n)
    }
}
/// The TUI's `truth`: service stale flags are booleans, but anything truthy
/// marks the reading historical.
fn truth(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn fields(input: Option<&Value>) -> Value {
    let offline = json!({"online":false,"planner":null,"agent":null,"usedPct":null,"pacePct":null,"verdict":null,"resetsAt":null,"running":null,"attention":null,"mode":null});
    let Some(input) = input else {
        return offline;
    };
    // Policy is a backend fact, never inferred from local configuration.
    // Omit missing older-service metadata just as the TypeScript fields do.
    let with_policy = |mut fields: Value| {
        if let Some(policy) = input.get("policy") {
            fields["policy"] = policy.clone();
        }
        fields
    };
    if input.get("generatedAt").is_some() {
        let p = input["providers"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == input["planner"]))
            .unwrap_or(&Value::Null);
        let agent = p["agent"]
            .as_str()
            .unwrap_or_else(|| runner_agent(input["planner"].as_str().unwrap_or_default()));
        // A stale reading never shows a live-looking figure; the TUI's
        // "stale reading" marker replaces it (see render).
        let stale = truth(p.get("stale").unwrap_or(&Value::Null));
        let mut fields = json!({"online":true,"planner":agent_info(agent).0,"agent":agent,
        "usedPct":if stale { Value::Null } else { p["binding"]["usedPct"].clone() },
        "pacePct":if stale { Value::Null } else { p["binding"]["pace"].clone() },
        "verdict":coalesce(&[&p["verdict"], &json!("UNKNOWN")]),"resetsAt":p["binding"]["resetsAt"],"running":null,"attention":null,"mode":input["mode"]});
        if stale {
            fields["stale"] = json!(true);
        }
        return with_policy(fields);
    }
    let p = planner_meter(input);
    let c = counts(input);
    let budget = &input["budget"];
    let legacy = budget["providers"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["id"] == budget["planner"]))
        .unwrap_or(&Value::Null);
    let agent = p["agent"]
        .as_str()
        .or_else(|| legacy["agent"].as_str())
        .or_else(|| budget["planner"].as_str().map(runner_agent));
    let Some(agent) = agent.filter(|a| !a.is_empty()) else {
        return offline;
    };
    let record = p.get("usageState").filter(|v| !v.is_null());
    let (usage_figure, usage_meter) = record.map_or((None, None), |s| {
        let (figure, meter) = super::usage::figure_words(Some(s));
        (Some(figure), meter)
    });
    let stale = if let Some(state) = record {
        state["freshness"].as_str() == Some("historical")
    } else {
        truth(p.get("stale").unwrap_or(&Value::Null))
    };
    let used_pct = if stale {
        Value::Null
    } else if let Some(meter) = usage_meter {
        json_meter(meter)
    } else if record.is_some() {
        Value::Null
    } else {
        coalesce(&[&p["usedPct"], &legacy["usedPct"]])
    };
    let pace_pct = if stale || (record.is_some() && usage_meter.is_none()) {
        Value::Null
    } else {
        coalesce(&[&p["pacePct"], &legacy["pacePct"]])
    };
    let state_verdict = record.map(|s| &s["verdict"]).unwrap_or(&Value::Null);
    let mut fields = with_policy(
        json!({"online":true,"planner":agent_info(agent).0,"agent":agent,
    "usedPct":used_pct,
    "pacePct":pace_pct,
    "verdict":coalesce(&[state_verdict,&p["verdict"],&legacy["verdict"],&json!("unknown")]),
    "resetsAt":coalesce(&[&p["resetsAt"],&legacy["resetsAt"]]),
    "running":count(&c["running"]),"attention":count(&c["attention"]),
    "mode":coalesce(&[&p["mode"],&input["mode"]["mode"],&budget["mode"],&json!("normal")])}),
    );
    if stale {
        fields["stale"] = json!(true);
    }
    if let Some(figure) = usage_figure {
        fields["usageFigure"] = json!(figure);
        fields["usageMeter"] = match usage_meter {
            Some(m) => json_meter(m),
            None => Value::Null,
        };
    }
    fields
}
