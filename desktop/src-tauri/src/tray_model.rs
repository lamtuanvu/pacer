use serde_json::Value;

/// Only native tray state; the popover page owns the detailed service view.
#[derive(Debug)]
pub struct TrayModel {
    pub title: String,
    pub paused: bool,
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
        let update = s["desktopUpdates"].as_array().is_some_and(|updates| {
            updates.iter().any(|update| matches!(update["phase"].as_str(), Some("ready" | "waiting")))
        });
        Self {
            title: format!("{percent}{}{}", if count > 0 { " •" } else { "" }, if update { " ↑" } else { "" }),
            paused: s["pause"].is_object(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn desktop_update_indicator_preserves_attention_and_pause() {
        let model = TrayModel::from_snapshot(&json!({"planner":{"usedPct":42},"counts":{"attention":2},"pause":{},"desktopUpdates":[{"phase":"ready"}]}));
        assert_eq!(model.title, "42% • ↑");
        assert!(model.paused);
        assert_eq!(TrayModel::from_snapshot(&json!({"desktopUpdates":[{"phase":"waiting"}]})).title, "— ↑");
        assert_eq!(TrayModel::from_snapshot(&json!({"desktopUpdates":[{"phase":"idle"}]})).title, "—");
    }
    #[test]
    fn planner_percentage_and_service_owned_attention_dot() {
        let m = TrayModel::from_snapshot(
            &json!({"planner":{"label":"Codex","usedPct":42.4},"counts":{"needsYou":2}}),
        );
        assert_eq!(m.title, "42% •");
        assert!(
            !TrayModel::from_snapshot(&json!({"attention":[{"id":"t-1"}]}))
                .title
                .contains('•')
        );
        assert_eq!(
            TrayModel::from_snapshot(&json!({"planner":{"usedPct":110}})).title,
            "100%"
        );
    }
    #[test]
    fn pause_and_attention_count_precedence() {
        let m = TrayModel::from_snapshot(
            &json!({"pause":{"until":123},"counts":{"attention":0,"needsYou":9}}),
        );
        assert!(m.paused);
        assert!(!m.title.contains('•'));
        assert!(!TrayModel::from_snapshot(&json!({"pause":null})).paused);
    }
    #[test]
    fn v3_snapshot_uses_planner_counts_and_pause() {
        let m = TrayModel::from_snapshot(&json!({
            "protocol": "3.0.0",
            "seq": 1000000000003_u64,
            "snapshot": {
                "planner": {"label": "Codex", "usedPct": 42.4},
                "counts": {"attention": 2},
                "pause": {"until": 123},
                "service": {"starting": false},
                "future": true
            }
        }));
        assert_eq!(m.title, "42% •");
        assert!(m.paused);
    }
    #[test]
    fn legacy_snapshot_and_missing_fields() {
        let m = TrayModel::from_snapshot(
            &json!({"snapshot":{"budget":{"planner":"codex","providers":[{"id":"codex","usedPct":31}]}}}),
        );
        assert_eq!(m.title, "31%");
        assert_eq!(TrayModel::from_snapshot(&Value::Null).title, "—");
    }
}
