use pacer_plugin::{Manifest, Plugin, PluginError};
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
    plugin
        .handle("diagnostic.ping", move |_p, c| {
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
        })
        .serve_stdio()
        .await
}
