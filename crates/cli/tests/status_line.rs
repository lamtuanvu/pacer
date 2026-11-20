#![allow(clippy::unwrap_used)]
use std::process::Command;
#[test]
fn matches_every_typescript_golden() {
    // Set TZ on a separate process before jiff initializes; no unsafe env mutation.
    if std::env::var_os("PACER_GOLDEN_CHILD").is_none() {
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "matches_every_typescript_golden", "--nocapture"])
            .env("PACER_GOLDEN_CHILD", "1")
            .env("TZ", "Asia/Ho_Chi_Minh")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("golden/status-line.json")).unwrap();
    for c in &cases {
        let input = (!c["input"].is_null()).then_some(&c["input"]);
        let w = c["width"].as_u64().unwrap() as usize;
        let col = c["color"].as_bool().unwrap();
        assert_eq!(
            pacer_cli::status_line::render(input, w, col),
            c["out"].as_str().unwrap(),
            "width {w} color {col} input {}",
            c["input"]
        );
        assert_eq!(pacer_cli::status_line::fields(input), c["fields"]);
    }
}

/// A stale planner reading shows the TUI's "stale reading" marker instead of a
/// live-looking figure, on both the status and the legacy snapshot shape.
#[test]
fn stale_planner_reading_shows_the_stale_marker() {
    let mut status = serde_json::json!({
        "generatedAt": 1800000000,
        "planner": "claude-code",
        "mode": "normal",
        "providers": [{
            "id": "claude-code", "agent": "claude-code", "usage": "quota", "installed": true, "stale": true,
            "verdict": "UNKNOWN", "windows": [],
            "binding": {"usedPct": 63, "pace": 77, "resetsAt": 1800259200, "name": "weekly", "lengthS": 604800, "paced": true, "source": "native", "capturedAt": 1799990000},
        }],
    });
    let fields = pacer_cli::status_line::fields(Some(&status));
    assert_eq!(fields["stale"], serde_json::json!(true));
    assert_eq!(fields["usedPct"], serde_json::json!(null));
    assert_eq!(fields["pacePct"], serde_json::json!(null));
    assert_eq!(fields["verdict"], serde_json::json!("UNKNOWN"));
    let line = pacer_cli::status_line::render(Some(&status), 120, false);
    assert!(line.contains("stale reading"), "{line}");
    assert!(!line.contains("63%"), "{line}");
    // The non-stale twin keeps the figure.
    status["providers"][0]["stale"] = serde_json::json!(false);
    let fields = pacer_cli::status_line::fields(Some(&status));
    assert_eq!(fields["usedPct"], serde_json::json!(63));
    assert!(pacer_cli::status_line::render(Some(&status), 120, false).contains("63%·77"));
    // The legacy snapshot shape carries the same stale flag on its planner meter.
    let snapshot = serde_json::json!({
        "at": 1800000000,
        "planner": {"agent": "claude-code", "usedPct": 63, "pacePct": 77, "verdict": "on_pace", "resetsAt": 1800259200, "mode": "normal", "stale": true},
        "counts": {"running": 0, "attention": 0},
        "budget": {"planner": "claude-code", "mode": "normal", "providers": []},
    });
    let fields = pacer_cli::status_line::fields(Some(&snapshot));
    assert_eq!(fields["stale"], serde_json::json!(true));
    assert_eq!(fields["usedPct"], serde_json::json!(null));
    assert!(pacer_cli::status_line::render(Some(&snapshot), 120, false).contains("stale reading"));
}
