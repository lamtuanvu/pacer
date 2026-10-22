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
pub fn fields(input: Option<&Value>) -> Value {
    let offline = json!({"online":false,"planner":null,"agent":null,"usedPct":null,"pacePct":null,"verdict":null,"resetsAt":null,"running":null,"attention":null,"mode":null});
    let Some(input) = input else {
        return offline;
    };
    if input.get("generatedAt").is_some() {
        let p = input["providers"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == input["planner"]))
            .unwrap_or(&Value::Null);
        let agent = p["agent"]
            .as_str()
            .unwrap_or_else(|| runner_agent(input["planner"].as_str().unwrap_or_default()));
        return json!({"online":true,"planner":agent_info(agent).0,"agent":agent,"usedPct":p["binding"]["usedPct"],"pacePct":p["binding"]["pace"],"verdict":coalesce(&[&p["verdict"], &json!("UNKNOWN")]),"resetsAt":p["binding"]["resetsAt"],"running":null,"attention":null,"mode":input["mode"]});
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
    json!({"online":true,"planner":agent_info(agent).0,"agent":agent,
        "usedPct":coalesce(&[&p["usedPct"],&legacy["usedPct"]]),
        "pacePct":coalesce(&[&p["pacePct"],&legacy["pacePct"]]),
        "verdict":coalesce(&[&p["verdict"],&legacy["verdict"],&json!("unknown")]),
        "resetsAt":coalesce(&[&p["resetsAt"],&legacy["resetsAt"]]),
        "running":count(&c["running"]),"attention":count(&c["attention"]),
        "mode":coalesce(&[&p["mode"],&input["mode"]["mode"],&budget["mode"],&json!("normal")])})
}
