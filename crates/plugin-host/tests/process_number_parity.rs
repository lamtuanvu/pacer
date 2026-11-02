#![allow(clippy::unwrap_used)]

use pacer_plugin_host::{ProcessFrame, parse_frame};
use std::process::Command;

#[test]
fn response_ids_match_javascript_pending_lookup() {
    let cases = ["1", "1.0", "1e0", "1.5", "-1", "9007199254740992"];
    let script = "const ids=JSON.parse(Bun.argv.at(-1)); console.log(JSON.stringify(ids.map(s=>new Map([[1,true]]).has(JSON.parse(s)))))";
    let output = Command::new("bun")
        .args(["-e", script, &serde_json::to_string(&cases).unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    for (case, expected) in cases.iter().zip(expected) {
        let frame = format!(r#"{{"jsonrpc":"2.0","id":{case},"result":true}}"#);
        let matches_pending = matches!(
            parse_frame(frame.as_bytes()),
            Ok(ProcessFrame::Response { id: 1, .. })
        );
        assert_eq!(matches_pending, expected, "id {case}");
    }
}
