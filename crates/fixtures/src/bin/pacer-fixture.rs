use pacer_plugin::{
    Manifest, Plugin, PluginError,
    types::{WorkflowDefinitionsParams, WorkflowDefinitionsResult},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    ping_delay_ms: Option<u64>,
    slow_pings: Option<u64>,
    crash_after_pings: Option<u64>,
    exit_at_start: Option<bool>,
    ignore_cancel: Option<bool>,
    claim_contributes: Option<Vec<String>>,
    call_capability: Option<String>,
    /// Pages for `workflow.definitions` (≤1 workflow each). Absent → no workflow handler.
    workflow_pages: Option<Vec<Value>>,
}

fn workflow_page(
    pages: &[Value],
    after: Option<&str>,
    plugin_id: &str,
) -> Result<WorkflowDefinitionsResult, PluginError> {
    let idx = match after {
        None => 0usize,
        Some(cursor) => pages
            .iter()
            .position(|page| page.get("next").and_then(Value::as_str) == Some(cursor))
            .map(|i| i + 1)
            .unwrap_or(usize::MAX),
    };
    let Some(page) = pages.get(idx) else {
        return Ok(WorkflowDefinitionsResult {
            workflows: vec![],
            next: None,
        });
    };
    let mut body = page.clone();
    if let Some(obj) = body.as_object_mut() {
        // `next` is a page cursor, not part of the workflow entry schema.
        // Keep it on the result envelope only.
        let next = obj.remove("next");
        let mut workflows = obj.remove("workflows").unwrap_or_else(|| json!([]));
        if let Some(items) = workflows.as_array_mut() {
            for item in items {
                if let Some(source) = item
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                {
                    item["source"] = Value::String(source.replace("__PLUGIN__", plugin_id));
                }
            }
        }
        let mut envelope = serde_json::Map::new();
        envelope.insert("workflows".into(), workflows);
        if let Some(next) = next {
            envelope.insert("next".into(), next);
        }
        body = Value::Object(envelope);
    }
    serde_json::from_value(body).map_err(|e| PluginError::new("invalid_input", e.to_string()))
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string("pacer-plugin.json")?)?;
    let fx: Fixture = serde_json::from_str(&std::fs::read_to_string("fixture.json")?)?;
    if fx.exit_at_start == Some(true) {
        std::process::exit(3);
    }
    let id = manifest["id"].as_str().unwrap_or("fx").to_owned();
    let fx = Arc::new(fx);
    let pings = Arc::new(AtomicU64::new(0));
    let mut plugin = Plugin::new(Manifest(manifest));
    if let Some(points) = fx.claim_contributes.clone() {
        plugin = plugin.contributes(points);
    }
    plugin = plugin.handle("diagnostic.ping", {
        let fx = fx.clone();
        let pings = pings.clone();
        let id = id.clone();
        move |_p, c| {
            let (fx, pings, id) = (fx.clone(), pings.clone(), id.clone());
            async move {
                let n = pings.fetch_add(1, Ordering::SeqCst) + 1;
                eprintln!("fixture {id}: ping {n}");
                if let Some(cap) = &fx.call_capability {
                    let params = if cap == "log" {
                        json!({"level":"info","message":"hello from fixture"})
                    } else {
                        json!({})
                    };
                    c.host.call(&format!("capability.{cap}"), params).await?;
                }
                if let Some(ms) = fx
                    .ping_delay_ms
                    .filter(|_| fx.slow_pings.is_none_or(|s| n <= s))
                {
                    let sleep = tokio::time::sleep(Duration::from_millis(ms));
                    if fx.ignore_cancel == Some(true) {
                        sleep.await
                    } else {
                        tokio::select! { _ = sleep => {}, _ = c.cancel.cancelled() => {} }
                    }
                }
                if c.cancel.is_cancelled() {
                    return Err(PluginError::new("cancelled", "ping cancelled"));
                }
                if fx.crash_after_pings.is_some_and(|k| k > 0 && n >= k) {
                    tokio::spawn(async {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        std::process::exit(7)
                    });
                }
                Ok(json!({"ok": true, "uptimeS": 0}))
            }
        }
    });
    if let Some(pages) = fx.workflow_pages.clone() {
        let pages = Arc::new(pages);
        let plugin_id = id.clone();
        plugin = plugin.workflow_definitions(move |params: WorkflowDefinitionsParams, _c| {
            let pages = pages.clone();
            let plugin_id = plugin_id.clone();
            async move {
                let after = params.after.as_ref().map(|a| a.as_str().to_owned());
                workflow_page(&pages, after.as_deref(), &plugin_id)
            }
        });
    }
    plugin.serve_stdio().await
}
