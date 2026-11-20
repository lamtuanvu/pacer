//! `assistant.delta` notifications while a turn runs.

use pacer_plugin::Progress;
use serde_json::json;

pub fn text(progress: &Progress, turn_id: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    // Host schema caps text at 4096 characters; send in chunks if needed.
    for chunk in text
        .chars()
        .collect::<Vec<_>>()
        .chunks(4096)
        .map(|c| c.iter().collect::<String>())
    {
        progress.notify(
            "assistant.delta",
            json!({ "turnId": turn_id, "kind": "text", "text": chunk }),
        );
    }
}

pub fn activity(progress: &Progress, turn_id: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let clipped: String = text.chars().take(4096).collect();
    progress.notify(
        "assistant.delta",
        json!({ "turnId": turn_id, "kind": "activity", "text": clipped }),
    );
}
