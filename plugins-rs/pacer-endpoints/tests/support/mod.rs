#![allow(clippy::unwrap_used)]
#![allow(dead_code)]
//! Shared scripted-host helpers for the `pacer-endpoints` integration tests.
//! These drive the real bundled `pacer_bundled_endpoints::plugin()` through the
//! SDK `Harness` over the wire, matching how the parity driver drives the TS and
//! Rust front doors. The filesystem answers mirror the TS `fixture` and capture
//! every inline write so tests can assert exact written bytes.

use pacer_plugin::testing::{Harness, HelloSpec};
use pacer_plugin::Plugin;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// An in-memory mirror of the host filesystem: records inline writes and
/// answers `write`/`mkdir`/`read`. Only inline (non-staged) writes are
/// recorded because `pacer-endpoints` config files are always small.
#[derive(Default)]
pub struct InMemoryFs {
    /// Every inline write paramped to `capability.fs.write`, in order.
    pub written: Vec<(String, String, Option<u64>)>,
    /// Path → content for reads (seeded by the test).
    pub files: std::collections::HashMap<String, String>,
}

/// Register the standard filesystem answers that drive `state`, so the plugin's
/// `fs` facade happy-paths succeed and record what was written.
pub fn base_fs_answers(h: &mut Harness, state: Arc<Mutex<InMemoryFs>>) {
    let s = state.clone();
    h.on_capability("capability.fs.write", move |p| {
        let mut s = s.lock().unwrap();
        let path = p.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
        let text = p.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
        let mode = p.get("mode").and_then(Value::as_u64);
        s.written.push((path, text, mode));
        Ok(json!({ "ok": true }))
    });
    h.on_capability("capability.fs.mkdir", move |_| Ok(json!({ "ok": true })));
    let s = state;
    h.on_capability("capability.fs.read", move |p| {
        let s = s.lock().unwrap();
        let path = p.get("path").and_then(Value::as_str).unwrap_or_default();
        match s.files.get(path) {
            Some(text) => Ok(json!({ "text": text })),
            None => Ok(json!({ "missing": true })),
        }
    });
}

/// Build the bundled `pacer-endpoints` plugin.
pub fn plugin() -> Plugin {
    pacer_bundled_endpoints::plugin()
}

/// A default hello spec with the TS SDK feature set so the plugin's protocol
/// gate passes and chunked results flow as on the real host.
pub fn hello() -> HelloSpec {
    HelloSpec {
        features: pacer_plugin::TS_SDK_FEATURES.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}