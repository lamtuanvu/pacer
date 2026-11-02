//! Presentation only: action labels describe advertised capabilities, never invoke them.
use crate::{layout::*, model::*, render::*, settings::field};
use serde_json::Value as V;
pub struct UpdateView {
    pub label: String,
    pub glyph: &'static str,
    pub tone: &'static str,
    pub detail: String,
    pub action: Option<&'static str>,
}
pub fn action_label(a: &str) -> &str {
    match a {
        "download" => "Download update",
        "restart" => "Restart to update",
        "cancel" => "Cancel update",
        "adopt" => "Use the desktop service",
        "adoptCancel" => "Cancel service change",
        "configure" => "Download updates automatically",
        _ => "Check for updates",
    }
}
pub fn view(u: &V) -> UpdateView {
    let (mut label, mut tone, mut glyph, mut detail) = match text(&u["phase"]) {
        "idle" => {
            if truth(&u["target"]) {
                (
                    "Update available",
                    "info",
                    "↓",
                    "An update is available to download.",
                )
            } else if u["checkedAt"].is_null() {
                (
                    "Not checked",
                    "neutral",
                    "…",
                    "Check for a newer version of pacer.",
                )
            } else {
                (
                    "Up to date",
                    "neutral",
                    "✓",
                    "Check for a newer version of pacer.",
                )
            }
        }
        "checking" => (
            "Checking for updates",
            "info",
            "…",
            "Looking for a new version.",
        ),
        "downloading" => (
            "Downloading update",
            "info",
            "↓",
            "Downloading the update. You can keep working.",
        ),
        "ready" => (
            "Update ready",
            "info",
            "↑",
            "The update is downloaded. Restart when you're ready.",
        ),
        "waiting" => (
            "Waiting for work to finish",
            "warn",
            "…",
            "The update will start after active work and sessions finish. You can cancel while it waits.",
        ),
        "reserved" => (
            "Preparing update",
            "info",
            "…",
            "Installation has started. Cancellation is no longer available.",
        ),
        "installing" => (
            "Installing update",
            "info",
            "…",
            "pacer will restart when installation finishes. Cancellation is no longer available.",
        ),
        "verifying" => (
            "Starting the updated app",
            "info",
            "…",
            "Checking that the updated app and service are ready.",
        ),
        "complete" => ("Updated", "good", "✓", "The updated app is ready."),
        "rolling-back" => (
            "Restoring the previous version",
            "warn",
            "…",
            "The update couldn't start. Restoring your previous version.",
        ),
        "restored" => (
            "Previous version restored",
            "warn",
            "!",
            "The update couldn't start. Your previous version has been restored.",
        ),
        "error" => (
            "Update needs attention",
            "bad",
            "!",
            u["error"]["message"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("The update couldn't finish. Check again when you're ready."),
        ),
        "recovery-failed" => (
            "Recovery needs attention",
            "bad",
            "!",
            "An update didn't finish, and pacer couldn't put the previous version back on its own. Your tasks and settings are safe. Keep this app installed and leave the files in your pacer folder as they are: pacer needs them to recover. Quit pacer, then report the problem at github.com/lamtuanvu/pacer/issues.",
        ),
        _ => (
            "Update status unavailable",
            "neutral",
            "?",
            "Refresh the status or use a compatible desktop app.",
        ),
    };
    let mut owned_detail = None;
    if u["phase"] == "downloading" && num(&u["totalBytes"]) > 0. {
        owned_detail = Some(format!(
            "{}% downloaded. You can keep working.",
            number(
                (num(&u["downloadedBytes"]) / num(&u["totalBytes"]) * 100.)
                    .floor()
                    .clamp(0., 100.)
            )
        ));
    }
    let actions = arr(&u["actions"]);
    let has = |a: &str| actions.iter().any(|v| text(v) == a);
    let adoption = &u["adoption"];
    if u["ownership"] == "attached" && u["phase"] == "idle" && actions.is_empty() {
        detail = "This desktop is connected to an externally managed service. Update that service separately.";
    }
    if u["ownership"] == "attached"
        && !adoption.is_null()
        && matches!(text(&adoption["phase"]), "available" | "cancelled")
        && has("adopt")
    {
        label = "Externally managed service";
        tone = "neutral";
        glyph = "…";
        detail = "Use the bundled service to let the desktop manage this installation and enable desktop updates.";
        owned_detail = None;
    }
    let phase = text(&adoption["phase"]);
    if !adoption.is_null()
        && !matches!(phase, "available" | "cancelled")
        && (!matches!(phase, "committed" | "restored")
            || (matches!(text(&u["phase"]), "idle" | "complete") && !truth(&u["target"])))
    {
        (label, tone, glyph, detail) = match phase {
            "waiting" => (
                "Waiting to switch services",
                "warn",
                "…",
                "The service will change after active work and sessions finish. You can cancel while it waits.",
            ),
            "reserved" => (
                "Preparing service change",
                "info",
                "…",
                "The service change has started. Cancellation is no longer available.",
            ),
            "installing" => (
                "Switching services",
                "info",
                "…",
                "pacer is switching to the bundled desktop service.",
            ),
            "verifying" => (
                "Checking the desktop service",
                "info",
                "…",
                "Checking the new service and reconnecting this desktop.",
            ),
            "committed" => (
                "Desktop service is ready",
                "good",
                "✓",
                "The desktop now manages this service. Your tasks and settings are preserved.",
            ),
            "restored" => (
                "Previous service restored",
                "warn",
                "!",
                "The service change could not finish. The original service has been restored.",
            ),
            "recovery-failed" => (
                "Service recovery needs attention",
                "bad",
                "!",
                "The original service could not be restored automatically. Keep your data and recovery files in place and report the problem at github.com/lamtuanvu/pacer/issues.",
            ),
            _ => (
                "Service status unavailable",
                "neutral",
                "?",
                "Refresh the service status.",
            ),
        };
        owned_detail = None;
    }
    if matches!(
        text(&u["error"]["code"]),
        "coordination_failed" | "notification_failed"
    ) {
        label = if u["error"]["code"] == "coordination_failed" {
            "Rechecking update"
        } else {
            "Update status delayed"
        };
        tone = "warn";
        glyph = "…";
        detail = text(&u["error"]["message"]);
        owned_detail = None;
    }
    UpdateView {
        label: label.into(),
        tone,
        glyph,
        detail: owned_detail.unwrap_or_else(|| detail.into()),
        action: [
            "adoptCancel",
            "cancel",
            "restart",
            "download",
            "adopt",
            "check",
        ]
        .into_iter()
        .find(|a| has(a)),
    }
}
pub fn badge(updates: &V) -> String {
    let items = arr(updates);
    let u = items
        .iter()
        .find(|u| {
            matches!(text(&u["phase"]), "recovery-failed" | "error" | "restored")
                || u["adoption"]["phase"] == "recovery-failed"
        })
        .or_else(|| {
            items.iter().find(|u| {
                !matches!(text(&u["phase"]), "idle" | "complete")
                    || truth(&u["target"])
                    || (!u["adoption"].is_null()
                        && !matches!(
                            text(&u["adoption"]["phase"]),
                            "available" | "cancelled" | "committed"
                        ))
            })
        });
    if let Some(u) = u {
        let v = view(u);
        format!(
            " {}",
            if v.tone == "bad" {
                "failed"
            } else if v.tone == "warn" {
                if v.glyph == "!" {
                    "restored"
                } else {
                    "waiting"
                }
            } else if v.label == "Update available" {
                "available"
            } else if v.glyph == "↑" {
                "ready"
            } else {
                "active"
            }
        )
    } else {
        String::new()
    }
}
pub fn build(ctx: &Ctx, w: usize) -> (Vec<Row>, Vec<Item>, Vec<String>) {
    let mut rows = vec![];
    let mut items = vec![];
    let mut hints = vec![];
    for status in arr(&ctx.s["desktopUpdates"]) {
        let mut available = status.clone();
        available["actions"] = V::Array(
            arr(&status["actions"])
                .iter()
                .filter(|a| ctx.supports(&format!("desktop.update.{}", text(a))))
                .cloned()
                .collect(),
        );
        let v = view(&available);
        let prefix = format!("desktop:{}", text(&status["installationId"]));
        let primary = v.action.map(action_label);
        items.push(Item::new(
            &prefix,
            primary,
            0,
            &if let Some(p) = primary {
                vec![("u", p)]
            } else {
                vec![]
            },
        ));
        if primary.is_some() && hints.is_empty() {
            hints.push("u update".into());
        }
        let version = if truth(&status["target"]) && status["target"] != status["current"] {
            format!("{} → {}", text(&status["current"]), text(&status["target"]))
        } else {
            text(&status["current"]).into()
        };
        field(
            &mut rows,
            w,
            "Desktop",
            vec![version, "  ".into(), format!("{} {}", v.glyph, v.label)],
            &primary
                .map(|p| format!("⏎ {}", p.to_lowercase()))
                .unwrap_or_default(),
            &prefix,
        );
        rows.extend(prose(&v.detail, w));
        if truth(&status["error"]["hint"]) {
            rows.extend(prose(text(&status["error"]["hint"]), w));
        }
        let a = &status["adoption"];
        if !a.is_null() {
            field(
                &mut rows,
                w,
                "Service",
                line(format!(
                    "{} on port {}",
                    text(&a["serviceLabel"]),
                    js_string(&a["port"])
                )),
                "",
                "",
            );
            for (label, key) in [
                ("Current", "currentServiceExecutable"),
                ("Desktop", "replacementServiceExecutable"),
            ] {
                for (i, l) in wrap_path(text(&a[key]), w.saturating_sub(11))
                    .iter()
                    .enumerate()
                {
                    rows.push(Row::new(line(format!(
                        "  {}{l}",
                        if i == 0 {
                            format!("{label}: ")
                                .chars()
                                .chain(std::iter::repeat(' '))
                                .take(9)
                                .collect::<String>()
                        } else {
                            " ".repeat(9)
                        }
                    ))));
                }
            }
        }
        rows.push(Row::new(line(format!(
            "Last checked: {}",
            if status["checkedAt"].is_null() {
                "never".into()
            } else {
                ctx.time(&status["checkedAt"])
            }
        ))));
        for b in arr(&status["blockers"]).iter().chain(arr(&a["blockers"])) {
            rows.push(Row::new(line(format!("  {}", text(&b["label"])))));
        }
        let actions = arr(&available["actions"]);
        if actions.iter().any(|v| v == "check") && v.action != Some("check") {
            let id = format!("{prefix}:check");
            items.push(Item::new(&id, Some("Check for updates"), 0, &[]));
            field(&mut rows, w, "", line("Check for updates"), "", &id);
        }
        if actions.iter().any(|v| v == "configure") {
            let id = format!("{prefix}:configure");
            items.push(Item::new(
                &id,
                Some("Download updates automatically"),
                0,
                &[],
            ));
            field(
                &mut rows,
                w,
                "Download automatically",
                line(if truth(&status["autoDownload"]) {
                    "On"
                } else {
                    "Off"
                }),
                "restart always asks",
                &id,
            );
        }
        rows.push(blank());
    }
    (rows, items, hints)
}
pub(crate) fn wrap_path(path: &str, w: usize) -> Vec<String> {
    wrap_path_units(path, w)
        .iter()
        .map(|line| String::from_utf16_lossy(line))
        .collect()
}

// String.length and slice operate on code units, even through surrogate pairs.
// Keep those units until the terminal UTF-8 boundary replaces isolated halves.
pub(crate) fn wrap_path_units(path: &str, w: usize) -> Vec<Vec<u16>> {
    let max = w.max(8);
    let mut lines = vec![];
    let mut current = vec![];
    let units: Vec<_> = path.encode_utf16().collect();
    for part in units.split_inclusive(|c| *c == b'/' as u16) {
        if !current.is_empty() && current.len() + part.len() > max {
            lines.push(current);
            current = vec![];
        }
        let mut rest = part;
        while rest.len() > max {
            lines.push(rest[..max].to_vec());
            rest = &rest[max..];
        }
        current.extend_from_slice(rest);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}
