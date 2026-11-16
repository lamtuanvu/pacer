//! Client storage snapshots; storage order determines notifier precedence.
use crate::{Error, n, s};
use serde_json::{Value, json};
const KINDS: [&str; 7] = ["app", "desktop", "orca", "tui", "status", "tray", "cli"];
/// Mirrors z.array(entrySchema): one malformed row invalidates the entire file.
pub fn read(raw: &Value) -> Vec<Value> {
    let Some(rows) = raw.as_array() else {
        return vec![];
    };
    const PERMS: [&str; 6] = [
        "not_determined",
        "denied",
        "authorized",
        "provisional",
        "ephemeral",
        "unsupported",
    ];
    const ALERTS: [&str; 3] = ["none", "banner", "alert"];
    if !rows.iter().all(|r| {
        !s(&r["client_id"]).is_empty()
            && KINDS.contains(&s(&r["kind"]))
            && !s(&r["version"]).is_empty()
            && r["notifier"].is_boolean()
            && r["registeredAt"].is_number()
            && r["heartbeatAt"].is_number()
            && (r.get("notification_permission").is_none()
                || PERMS.contains(&s(&r["notification_permission"])))
            && (r.get("notification_alerts").is_none()
                || ALERTS.contains(&s(&r["notification_alerts"])))
    }) {
        return vec![];
    }
    rows.iter().map(|r| {
        let mut out = json!({"client_id":r["client_id"],"kind":r["kind"],"version":r["version"],"notifier":r["notifier"],"registeredAt":r["registeredAt"],"heartbeatAt":r["heartbeatAt"]});
        if let Some(v) = r.get("notification_permission") { out["notification_permission"] = v.clone(); }
        if let Some(v) = r.get("notification_alerts") { out["notification_alerts"] = v.clone(); }
        if let Some(v) = r.get("permission_changed_at") { out["permission_changed_at"] = v.clone(); }
        out
    }).collect()
}
pub fn register(rows: &mut Vec<Value>, options: &Value, id: &str, now: f64) -> Value {
    rows.retain(|r| now - n(&r["heartbeatAt"]) <= 86400.0);
    let mut row = options.clone();
    row["notifier"] = options["notifier"].as_bool().unwrap_or(false).into();
    row["client_id"] = id.into();
    row["registeredAt"] = now.into();
    row["heartbeatAt"] = now.into();
    rows.push(row);
    json!({"client_id":id,"lease_s":30})
}
/// A `Some` notifier replaces the stored flag so a client can stop or resume presenting.
pub fn heartbeat(
    rows: &mut [Value],
    id: &str,
    notifier: Option<bool>,
    notification_permission: Option<&str>,
    notification_alerts: Option<&str>,
    now: f64,
) -> Result<Value, Error> {
    let row = rows
        .iter_mut()
        .find(|r| s(&r["client_id"]) == id)
        .ok_or_else(|| Error::new("invalid_input", format!("unknown client \"{id}\"")))?;
    row["heartbeatAt"] = now.into();
    if let Some(notifier) = notifier {
        row["notifier"] = notifier.into();
    }
    let changed = real_change(&row["notification_permission"], notification_permission)
        || real_change(&row["notification_alerts"], notification_alerts);
    if let Some(permission) = notification_permission {
        row["notification_permission"] = permission.into();
    }
    if let Some(alerts) = notification_alerts {
        row["notification_alerts"] = alerts.into();
    }
    if changed {
        row["permission_changed_at"] = now.into();
    }
    Ok(json!({"ok":true}))
}

/// A change between two real states counts: the previous stored value and the
/// reported value must both be present and neither may be the `unsupported`
/// placeholder, so a first report or an unbundled build does not stamp
/// `permission_changed_at` and an app relaunch does not reset "test delivered".
fn real_change(stored: &Value, provided: Option<&str>) -> bool {
    let Some(next) = provided else {
        return false;
    };
    if next == "unsupported" {
        return false;
    }
    let Some(prev) = stored.as_str() else {
        return false;
    };
    prev != "unsupported" && prev != next
}
pub fn list(rows: &[Value], now: f64) -> Vec<Value> {
    rows.iter()
        .filter(|r| now - n(&r["heartbeatAt"]) <= 45.0)
        .cloned()
        .collect()
}
pub fn active(rows: &[Value], now: f64) -> Value {
    list(rows, now)
        .into_iter()
        .rev()
        .find(|r| r["notifier"] == true)
        .unwrap_or(Value::Null)
}

fn medium_for(kind: &str) -> Option<&'static str> {
    match kind {
        "desktop" => Some("os"),
        "tui" => Some("terminal"),
        "app" => Some("browser"),
        _ => None,
    }
}

fn pick_presenter<'a>(live: &'a [Value], medium: &str) -> Option<&'a Value> {
    live.iter()
        .rev()
        .find(|r| r["notifier"] == true && medium_for(s(&r["kind"])) == Some(medium))
}

/// JSON array of `{client_id, kind, medium}` for live delivery notifiers.
pub fn presenters(rows: &[Value], now: f64) -> Value {
    let live = list(rows, now);
    let os = pick_presenter(&live, "os");
    let terminal = pick_presenter(&live, "terminal");
    let browser = pick_presenter(&live, "browser");
    let mut out = vec![];
    if let Some(r) = os {
        out.push(json!({"client_id": r["client_id"], "kind": r["kind"], "medium": "os"}));
    }
    if let Some(r) = terminal {
        out.push(json!({"client_id": r["client_id"], "kind": r["kind"], "medium": "terminal"}));
    }
    if os.is_none()
        && let Some(r) = browser
    {
        out.push(json!({"client_id": r["client_id"], "kind": r["kind"], "medium": "browser"}));
    }
    Value::Array(out)
}
