use crate::logic::route;
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct Item {
    pub label: String,
    pub route: Option<String>,
}
#[derive(Debug)]
pub struct TrayModel {
    pub title: String,
    pub planner: String,
    pub needs: Vec<Item>,
    pub running: Vec<Item>,
    pub executors: Vec<String>,
    pub paused: bool,
    pub strategies: Vec<(String, bool)>,
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn items(value: &Value, screen: &str) -> Vec<Item> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(3)
        .map(|v| {
            let label = [text(v, "title"), text(v, "goal"), text(v, "id")]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or("Task");
            let action = v.get("primaryAction").or_else(|| v["actions"].get(0));
            let label = match action.and_then(|a| a["label"].as_str()) {
                Some(a) => format!("{label} · {a}"),
                None => label.to_owned(),
            };
            let target = action
                .and_then(|a| a["route"].as_str())
                .and_then(route)
                .or_else(|| v["route"].as_str().and_then(route))
                .or_else(|| route(&format!("/{screen}/{}", text(v, "id"))));
            Item {
                label,
                route: target,
            }
        })
        .collect()
}
impl TrayModel {
    pub fn from_snapshot(raw: &Value) -> Self {
        let s = raw.get("snapshot").unwrap_or(raw);
        let planner = &s["planner"];
        let name = planner["label"]
            .as_str()
            .or_else(|| planner["name"].as_str())
            .or_else(|| s["budget"]["planner"].as_str())
            .unwrap_or("Planner");
        let provider = s["budget"]["providers"]
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(name)));
        let pct = planner["usedPct"]
            .as_f64()
            .or_else(|| provider.and_then(|p| p["usedPct"].as_f64()))
            .filter(|p| p.is_finite());
        let percent = pct
            .map(|p| format!("{:.0}%", p.clamp(0., 100.)))
            .unwrap_or_else(|| "—".into());
        // Only service-owned counts determine the attention dot. Do not infer a verdict from task states.
        let count = s["counts"]["attention"]
            .as_u64()
            .or_else(|| s["counts"]["needsYou"].as_u64())
            .unwrap_or(0);
        let needs = s["attention"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| Item {
                label: item["title"].as_str().unwrap_or("Needs you").into(),
                route: Some(crate::actions::attention_route(item)),
            })
            .collect();
        let running = if s["running"].is_array() {
            items(&s["running"], "session")
        } else {
            let tasks: Vec<Value> = s["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|t| t["state"] == "running")
                .cloned()
                .collect();
            items(&Value::Array(tasks), "session")
        };
        let executors = s["executors"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| {
                let name = e["label"]
                    .as_str()
                    .or_else(|| e["id"].as_str())
                    .unwrap_or("Executor");
                format!("{name} · {}", e["status"].as_str().unwrap_or("unknown"))
            })
            .collect();
        Self {
            title: format!("{percent}{}", if count > 0 { " •" } else { "" }),
            planner: format!("{name} · {percent} used"),
            needs,
            running,
            executors,
            paused: s["pause"].is_object(),
            strategies: s["strategies"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    let name = v.as_str().or_else(|| v["name"].as_str())?;
                    Some((name.into(), v["active"] == true))
                })
                .collect(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn limits_and_service_owned_dot() {
        let s = json!({"planner":{"label":"Codex","usedPct":42.4},"counts":{"needsYou":2},"attention":[{"id":"t-1","title":"Review","actions":[{"label":"Open","op":"ui.open","params":{"view":"review","id":"t-1"}}]},{"id":"t-2"},{"id":"t-3"},{"id":"t-4"}],"tasks":[{"id":"t-5","state":"running","goal":"Build"}]});
        let m = TrayModel::from_snapshot(&s);
        assert_eq!(m.title, "42% •");
        assert_eq!(m.needs.len(), 4);
        assert_eq!(m.needs[0].route.as_deref(), Some("#/review/t-1"));
        assert_eq!(m.running.len(), 1);
        assert!(
            !TrayModel::from_snapshot(&json!({"attention":[{"id":"t-1"}]}))
                .title
                .contains('•')
        );
    }
    #[test]
    fn pause_strategies_and_attention_order() {
        let m = TrayModel::from_snapshot(
            &json!({"pause":{"until":123},"counts":{"attention":0,"needsYou":9},"strategies":["default",{"name":"fast","active":true}],"attention":[{"id":"z","title":"First"},{"id":"a","title":"Second"}]}),
        );
        assert!(m.paused);
        assert!(!m.title.contains('•'));
        assert_eq!(
            m.strategies,
            vec![("default".into(), false), ("fast".into(), true)]
        );
        assert_eq!(m.needs[0].label, "First");
        assert_eq!(m.needs[1].label, "Second");
        assert!(!TrayModel::from_snapshot(&json!({"pause":null})).paused);
    }
    #[test]
    fn legacy_snapshot_and_missing_fields() {
        let m = TrayModel::from_snapshot(
            &json!({"snapshot":{"budget":{"planner":"codex","providers":[{"id":"codex","usedPct":31}]}}}),
        );
        assert_eq!(m.planner, "codex · 31% used");
        assert!(m.needs.is_empty());
        assert_eq!(TrayModel::from_snapshot(&Value::Null).title, "—");
    }
}
