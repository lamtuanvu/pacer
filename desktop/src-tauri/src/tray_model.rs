use serde_json::Value;

/// Only native tray state; the popover page owns the detailed service view.
#[derive(Debug)]
pub struct TrayModel {
    pub title: String,
    pub paused: bool,
    /// Text description of the menu-bar item, so the label is available, not only a glyph.
    pub tooltip: String,
    /// A failure that needs the user. The tray icon shows the red attention dot.
    pub alert: bool,
    /// Whether an update or adoption transaction is in flight; None unless built from a snapshot.
    pub transaction: Option<bool>,
}

/// The menu-bar form of one desktop update fact. It uses the same glyph, tone and
/// label as `desktopUpdateView` in src/view-model/updates.ts (UI-10).
#[derive(Debug, PartialEq, Eq)]
pub struct UpdateIndicator {
    pub glyph: &'static str,
    pub tone: &'static str,
    pub label: &'static str,
}

fn has_target(update: &Value) -> bool {
    update.get("target").is_some_and(|target| !target.is_null())
}

fn phase_view(update: &Value) -> (&'static str, &'static str, &'static str) {
    match update["phase"].as_str() {
        Some("idle") if has_target(update) => ("↓", "info", "Update available"),
        Some("idle") if update["checkedAt"].is_null() => ("…", "neutral", "Not checked"),
        Some("idle") => ("✓", "neutral", "Up to date"),
        Some("checking") => ("…", "info", "Checking for updates"),
        Some("downloading") => ("↓", "info", "Downloading update"),
        Some("ready") => ("↑", "info", "Update ready"),
        Some("waiting") => ("…", "warn", "Waiting for work to finish"),
        Some("reserved") => ("…", "info", "Preparing update"),
        Some("installing") => ("…", "info", "Installing update"),
        Some("verifying") => ("…", "info", "Starting the updated app"),
        Some("complete") => ("✓", "good", "Updated"),
        Some("rolling-back") => ("…", "warn", "Restoring the previous version"),
        Some("restored") => ("!", "warn", "Previous version restored"),
        Some("error") => ("!", "bad", "Update needs attention"),
        Some("recovery-failed") => ("!", "bad", "Recovery needs attention"),
        _ => ("?", "neutral", "Update status unavailable"),
    }
}

fn adoption_view(phase: Option<&str>) -> (&'static str, &'static str, &'static str) {
    match phase {
        Some("waiting") => ("…", "warn", "Waiting to switch services"),
        Some("reserved") => ("…", "info", "Preparing service change"),
        Some("installing") => ("…", "info", "Switching services"),
        Some("verifying") => ("…", "info", "Checking the desktop service"),
        Some("committed") => ("✓", "good", "Desktop service is ready"),
        Some("restored") => ("!", "warn", "Previous service restored"),
        Some("recovery-failed") => ("!", "bad", "Service recovery needs attention"),
        _ => ("?", "neutral", "Service status unavailable"),
    }
}

/// Mirrors the glyph, tone and label selection of `desktopUpdateView`, including adoption.
fn update_view(update: &Value) -> UpdateIndicator {
    let (mut glyph, mut tone, mut label) = phase_view(update);
    let phase = update["phase"].as_str();
    let adoption = update
        .get("adoption")
        .filter(|adoption| adoption.is_object());
    let adoption_phase = adoption.and_then(|adoption| adoption["phase"].as_str());
    let adopt_offered = update["actions"].as_array().is_some_and(|actions| {
        actions
            .iter()
            .any(|action| action.as_str() == Some("adopt"))
    });
    if update["ownership"].as_str() == Some("attached")
        && matches!(adoption_phase, Some("available" | "cancelled"))
        && adopt_offered
    {
        (glyph, tone, label) = ("…", "neutral", "Externally managed service");
    }
    if adoption.is_some()
        && !matches!(adoption_phase, Some("available" | "cancelled"))
        && (!matches!(adoption_phase, Some("committed" | "restored"))
            || (matches!(phase, Some("idle" | "complete")) && !has_target(update)))
    {
        (glyph, tone, label) = adoption_view(adoption_phase);
    }
    UpdateIndicator { glyph, tone, label }
}

/// Mirrors `desktopUpdateIndicator`: failures first, then any update in progress or available.
pub fn update_indicator(updates: &[Value]) -> Option<UpdateIndicator> {
    let failed = |update: &&Value| {
        matches!(
            update["phase"].as_str(),
            Some("recovery-failed" | "error" | "restored")
        ) || update["adoption"]["phase"].as_str() == Some("recovery-failed")
    };
    let active = |update: &&Value| {
        !matches!(update["phase"].as_str(), Some("idle" | "complete"))
            || has_target(update)
            || update.get("adoption").is_some_and(|adoption| {
                adoption.is_object()
                    && !matches!(
                        adoption["phase"].as_str(),
                        Some("available" | "cancelled" | "committed")
                    )
            })
    };
    updates
        .iter()
        .find(failed)
        .or_else(|| updates.iter().find(active))
        .map(update_view)
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
        let update = s["desktopUpdates"]
            .as_array()
            .and_then(|updates| update_indicator(updates));
        Self {
            title: format!(
                "{percent}{}{}",
                if count > 0 { " •" } else { "" },
                update
                    .as_ref()
                    .map(|update| format!(" {}", update.glyph))
                    .unwrap_or_default()
            ),
            paused: s["pause"].is_object(),
            tooltip: update
                .as_ref()
                .map(|update| format!("pacer: {}", update.label))
                .unwrap_or_else(|| "pacer".into()),
            alert: update.is_some_and(|update| update.tone == "bad"),
            transaction: Some(
                s["desktopUpdates"]
                    .as_array()
                    .is_some_and(|updates| transaction_in_flight(updates)),
            ),
        }
    }
}

/// Whether any update or adoption is waiting, reserved, installing, verifying, rolling back,
/// restoring or recovering. The snapshot only
/// lists installations of the service this desktop is connected to.
pub fn transaction_in_flight(updates: &[Value]) -> bool {
    let active = |phase: &Value| matches!(phase.as_str(), Some("waiting" | "reserved" | "installing" | "verifying" | "rolling-back" | "restoring" | "recovering"));
    updates
        .iter()
        .any(|update| active(&update["phase"]) || active(&update["adoption"]["phase"]))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn desktop_update_indicator_preserves_attention_and_pause() {
        let model = TrayModel::from_snapshot(
            &json!({"planner":{"usedPct":42},"counts":{"attention":2},"pause":{},"desktopUpdates":[{"phase":"ready","target":"1.1.0"}]}),
        );
        assert_eq!(model.title, "42% • ↑");
        assert_eq!(model.tooltip, "pacer: Update ready");
        assert!(model.paused);
        assert!(!model.alert);
        let idle = TrayModel::from_snapshot(
            &json!({"desktopUpdates":[{"phase":"idle","target":null,"checkedAt":5}]}),
        );
        assert_eq!(idle.title, "—");
        assert_eq!(idle.tooltip, "pacer");
    }
    #[test]
    fn update_and_adoption_transactions_are_in_flight() {
        let update = |phase: &str| json!({"desktopUpdates":[{"phase":phase,"target":"1.1.0"}]});
        let adopting = |phase: &str| json!({"desktopUpdates":[{"phase":"idle","target":null,"adoption":{"phase":phase}}]});
        for phase in ["waiting", "reserved", "installing", "verifying", "rolling-back", "restoring", "recovering"] {
            assert_eq!(TrayModel::from_snapshot(&update(phase)).transaction, Some(true), "{phase}");
            assert_eq!(TrayModel::from_snapshot(&adopting(phase)).transaction, Some(true), "{phase}");
        }
        for phase in ["idle", "ready", "available", "cancelled", "committed"] {
            assert_eq!(TrayModel::from_snapshot(&update(phase)).transaction, Some(false), "{phase}");
            assert_eq!(TrayModel::from_snapshot(&adopting(phase)).transaction, Some(false), "{phase}");
        }
        assert_eq!(TrayModel::from_snapshot(&Value::Null).transaction, Some(false));
    }
    fn title(update: Value) -> String {
        TrayModel::from_snapshot(&json!({ "desktopUpdates": [update] })).title
    }
    #[test]
    fn every_update_phase_uses_the_shared_glyph() {
        // The same glyphs as desktopUpdateView in src/view-model/updates.ts.
        for (phase, glyph) in [
            ("checking", "…"),
            ("downloading", "↓"),
            ("ready", "↑"),
            ("waiting", "…"),
            ("reserved", "…"),
            ("installing", "…"),
            ("verifying", "…"),
            ("rolling-back", "…"),
            ("restored", "!"),
            ("error", "!"),
            ("recovery-failed", "!"),
            ("future-phase", "?"),
        ] {
            assert_eq!(
                title(json!({"phase": phase, "target": null})),
                format!("— {glyph}"),
                "{phase}"
            );
        }
        assert_eq!(title(json!({"phase":"idle","target":"1.1.0"})), "— ↓");
        assert_eq!(title(json!({"phase":"complete","target":"1.1.0"})), "— ✓");
        // Idle or complete with nothing to offer shows no update signal, like the shared indicator.
        assert_eq!(
            title(json!({"phase":"idle","target":null,"checkedAt":null})),
            "—"
        );
        assert_eq!(title(json!({"phase":"complete","target":null})), "—");
    }
    #[test]
    fn failures_are_prominent_and_take_priority() {
        for (phase, tone, label) in [
            ("error", "bad", "Update needs attention"),
            ("recovery-failed", "bad", "Recovery needs attention"),
            ("restored", "warn", "Previous version restored"),
        ] {
            let model = TrayModel::from_snapshot(&json!({"desktopUpdates":[
                {"phase":"ready","target":"1.1.0"},
                {"phase": phase, "target": null}
            ]}));
            assert_eq!(model.title, "— !", "{phase}");
            assert_eq!(model.tooltip, format!("pacer: {label}"));
            assert_eq!(model.alert, tone == "bad");
        }
        let adoption = TrayModel::from_snapshot(&json!({"desktopUpdates":[
            {"phase":"ready","target":"1.1.0"},
            {"phase":"idle","target":null,"checkedAt":1,"ownership":"attached","actions":[],"adoption":{"phase":"recovery-failed"}}
        ]}));
        assert_eq!(adoption.title, "— !");
        assert_eq!(adoption.tooltip, "pacer: Service recovery needs attention");
        assert!(adoption.alert);
    }
    #[test]
    fn adoption_phases_override_like_the_shared_view() {
        let adopting = |phase: &str| json!({"phase":"idle","target":null,"checkedAt":1,"ownership":"attached","actions":[],"adoption":{"phase":phase}});
        assert_eq!(title(adopting("waiting")), "— …");
        assert_eq!(title(adopting("installing")), "— …");
        assert_eq!(title(adopting("restored")), "— !");
        // An available or committed adoption is not an indicator on its own.
        assert_eq!(title(adopting("available")), "—");
        assert_eq!(title(adopting("committed")), "—");
        // A committed adoption does not mask an update in progress.
        assert_eq!(
            title(json!({"phase":"ready","target":"1.1.0","adoption":{"phase":"committed"}})),
            "— ↑"
        );
        assert_eq!(
            update_indicator(&[
                json!({"phase":"downloading","target":"1.1.0","ownership":"attached","actions":["adopt"],"adoption":{"phase":"available"}})
            ]),
            Some(UpdateIndicator {
                glyph: "…",
                tone: "neutral",
                label: "Externally managed service"
            })
        );
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
