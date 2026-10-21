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
