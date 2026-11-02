use crate::file::js_number;
use crate::outbox::{
    append_outbox_for_publish, read_latest, read_outbox_since, reduce, rotate_outbox, write_latest,
};
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use serde_json::{Value, json};
use std::{io, time::Duration};

#[derive(Debug, Default)]
pub struct PublishReport {
    pub seq: u64,
    pub transports: Vec<&'static str>,
    pub errors: Vec<String>,
}

/// Serializes the outbox and snapshot under the same cross-runtime `link` lock.
/// Like the TypeScript publisher, persistence failures are returned in the report.
pub fn publish(ctx: &Ctx, events: &[Value]) -> PublishReport {
    let mut report = PublishReport::default();
    let options = LockOptions {
        timeout: Duration::from_secs(5),
        ..LockOptions::default()
    };
    let result = with_lock(ctx, "link", options, || -> io::Result<u64> {
        let mut snapshot = read_latest(ctx);
        for pending in read_outbox_since(ctx, snapshot["seq"].as_f64().unwrap_or(0.0))? {
            if pending["seq"].as_f64() != snapshot["seq"].as_f64().map(|seq| seq + 1.0) {
                return Err(io::Error::other(
                    "outbox sequence gap; latest snapshot requires recovery",
                ));
            }
            snapshot = reduce(
                &snapshot,
                &pending["envelope"],
                pending["at"].as_f64().unwrap_or(ctx.now),
            );
        }
        let mut entries = Vec::new();
        for event in events {
            snapshot = reduce(&snapshot, event, ctx.now);
            entries.push(json!({"seq":snapshot["seq"],"at":js_number(ctx.now),"envelope":event}));
        }
        if !entries.is_empty() {
            append_outbox_for_publish(ctx, &entries)?;
            write_latest(ctx, &snapshot)?;
            rotate_outbox(ctx)?;
        }
        Ok(snapshot["seq"].as_f64().unwrap_or(0.0) as u64)
    });
    match result {
        Ok(Ok(seq)) => {
            report.seq = seq;
            report.transports.push("outbox");
        }
        Ok(Err(e)) => report.errors.push(format!("outbox: {e}")),
        Err(e) => report.errors.push(format!("outbox: {e}")),
    }
    report
}

/// Publishes the activity entity first, then the config refresh, matching TS ordering.
pub fn publish_config_change(ctx: &Ctx, area: &str) -> io::Result<PublishReport> {
    crate::activity::append_activity(
        ctx,
        json!({"kind":"config","level":"info","text":format!("Configuration changed · {area}")}),
    )?;
    Ok(publish(
        ctx,
        &[json!({"type":"config","data":{"area":area,"at":js_number(ctx.now)}})],
    ))
}
