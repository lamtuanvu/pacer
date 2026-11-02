// Keep each optional nested shape visibly separate from its field validation.
#![allow(clippy::collapsible_if)]
use crate::file::{append_publication, atomic_publication, js_number, json_bytes};
use pacer_foundation::{Ctx, js_semantics::JsTrim};
use serde_json::{Value, json};
use std::{fs, io, path::PathBuf};

pub const OUTBOX_MAX_BYTES: u64 = 1024 * 1024;
pub const OUTBOX_KEEP: usize = 1000;

fn link_dir(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("link")
}
fn outbox_path(ctx: &Ctx) -> PathBuf {
    link_dir(ctx).join("outbox.jsonl")
}
fn latest_path(ctx: &Ctx) -> PathBuf {
    link_dir(ctx).join("latest.json")
}

pub fn empty_snapshot() -> Value {
    json!({"v":1,"seq":0,"at":0,"budget":null,"mode":null,"tasks":[],"alerts":[],"console":null,"consoles":[],"strategies":[]})
}

fn number(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}
fn safe_integer(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|seq| {
            seq.is_finite() && *seq >= 0.0 && seq.fract() == 0.0 && *seq <= 9_007_199_254_740_991.0
        })
        .map(|seq| seq as u64)
}
fn js_json(value: &Value) -> Value {
    match value {
        Value::Number(number) => number.as_f64().map_or(Value::Null, js_number),
        Value::Array(items) => Value::Array(items.iter().map(js_json).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), js_json(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
fn required_string(v: &Value, key: &str, max: usize) -> bool {
    v.get(key)
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= max)
}
fn string(v: &Value, key: &str, max: usize) -> Option<String> {
    Some(slice_utf16(v.get(key)?.as_str()?, max))
}
fn optional_string(v: &Value, key: &str, max: usize) -> Option<String> {
    string(v, key, max).filter(|s| !s.is_empty())
}
fn finite(v: &Value, key: &str) -> Value {
    v.get(key)
        .filter(|n| number(n))
        .cloned()
        .unwrap_or(Value::Null)
}
fn clip(s: &str, max: usize) -> String {
    if s.encode_utf16().count() <= max {
        s.to_owned()
    } else {
        format!("{}...", slice_utf16(s, max.saturating_sub(3)))
    }
}

pub(crate) fn slice_utf16(s: &str, max: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

fn parse_budget(data: &Value) -> Option<Value> {
    let generated = data.get("generatedAt").filter(|n| number(n))?;
    let strategy = string(data, "strategy", 128)?;
    let planner = string(data, "planner", 64)?;
    let mode = string(data, "mode", 32)?;
    let providers: Vec<Value> = data
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|p| {
            let id = string(p, "id", 64)?;
            let verdict = string(p, "verdict", 32)?;
            let mut row = json!({"id":id});
            if let (Some(agent), Some(account)) = (
                optional_string(p, "agent", 64),
                optional_string(p, "account", 64),
            ) {
                row["agent"] = json!(agent);
                row["account"] = json!(account);
            }
            if let Some(reason) = optional_string(p, "unavailableReason", 500) {
                row["unavailableReason"] = json!(reason);
            }
            row["verdict"] = json!(verdict);
            row["usedPct"] = finite(p, "usedPct");
            row["pacePct"] = finite(p, "pacePct");
            row["resetsAt"] = finite(p, "resetsAt");
            row["window"] = optional_string(p, "window", 32).map_or(Value::Null, Value::String);
            row["stale"] = json!(p.get("stale") == Some(&Value::Bool(true)));
            if let Some(reason) = optional_string(p, "brokenReason", 500) {
                row["brokenReason"] = json!(reason);
            }
            if let Some(reason) = optional_string(p, "blockedReason", 500) {
                row["blockedReason"] = json!(reason);
                row["blockedUntil"] = finite(p, "blockedUntil");
            }
            Some(row)
        })
        .collect();
    let ranked: Vec<Value> = data
        .get("ranked")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|r| Some(json!({"id":string(r,"id",64)?,"verdict":string(r,"verdict",32)?})))
        .collect();
    Some(
        json!({"generatedAt":generated,"strategy":strategy,"planner":planner,"mode":mode,"providers":providers,"ranked":ranked}),
    )
}

fn parse_task(data: &Value) -> Option<Value> {
    let id = string(data, "id", 128)?;
    let state = string(data, "state", 16)?;
    if id.is_empty() || state.is_empty() || !data.get("updatedAt").is_some_and(number) {
        return None;
    }
    let mut row = json!({"id":id,"state":state,"updatedAt":data["updatedAt"]});
    if let Some(title) = optional_string(data, "title", 60)
        .map(|s| s.js_trim().to_owned())
        .filter(|s| !s.is_empty())
    {
        row["title"] = json!(title);
    }
    row["goal"] = json!(string(data, "goal", 200).unwrap_or_default());
    for (key, max) in [("executor", 64), ("backend", 32), ("worktree", 4096)] {
        row[key] = optional_string(data, key, max).map_or(Value::Null, Value::String);
    }
    if data
        .get("interactionMode")
        .and_then(Value::as_str)
        .is_some_and(|s| ["delegated", "conversation"].contains(&s))
    {
        row["interactionMode"] = data["interactionMode"].clone();
    }
    if let Some(conversation) = data.get("conversation") {
        if conversation
            .get("activity")
            .and_then(Value::as_str)
            .is_some_and(|s| ["starting", "working", "waiting", "idle", "ended"].contains(&s))
        {
            let mut value = json!({"activity":conversation["activity"]});
            if let Some(id) = optional_string(conversation, "agentSessionId", 128) {
                value["agentSessionId"] = json!(id);
            }
            if conversation
                .get("endReason")
                .and_then(Value::as_str)
                .is_some_and(|s| ["user", "agent_exit", "failure"].contains(&s))
            {
                value["endReason"] = conversation["endReason"].clone();
            }
            row["conversation"] = value;
        }
    }
    if let Some(placement) = data.get("placement") {
        if placement
            .get("mode")
            .and_then(Value::as_str)
            .is_some_and(|s| ["current", "new"].contains(&s))
            && placement.get("why").is_some_and(Value::is_string)
        {
            row["placement"] = json!({"mode":placement["mode"],"why":string(placement,"why",240).unwrap_or_default()});
        }
    }
    if let Some(stop) = data.get("stopPending") {
        if stop
            .get("attempt")
            .and_then(safe_integer)
            .is_some_and(|n| n > 0)
            && stop.get("requestedAt").is_some_and(number)
            && optional_string(stop, "providerId", 128).is_some()
            && stop
                .get("graceMs")
                .and_then(safe_integer)
                .is_some_and(|n| n <= 25_000)
        {
            row["stopPending"] = json!({"attempt":stop["attempt"],"requestedAt":stop["requestedAt"],"providerId":optional_string(stop,"providerId",128),"graceMs":stop["graceMs"]});
        }
    }
    if let Some(session) = data.get("session") {
        if session
            .get("host")
            .and_then(Value::as_str)
            .is_some_and(|s| ["builtin", "orca", "none"].contains(&s))
            && session.get("live").is_some_and(Value::is_boolean)
            && session.get("viewers").is_some_and(number)
        {
            row["session"] = json!({"host":session["host"],"live":session["live"],"controller":optional_string(session,"controller",64),"viewers":session["viewers"].as_f64().unwrap_or(0.0).floor().clamp(0.0,99.0) as u64});
        }
    }
    if data.get("terminalPresent").is_some_and(Value::is_boolean) {
        row["terminalPresent"] = data["terminalPresent"].clone();
    }
    if let Some(v) = optional_string(data, "resolved", 240) {
        row["resolved"] = json!(v);
    }
    if let Some(review) = data.get("reviewRequest") {
        if review
            .get("note")
            .and_then(Value::as_str)
            .is_some_and(|s| s.encode_utf16().count() <= 2000)
            && review.get("at").is_some_and(number)
        {
            row["reviewRequest"] = json!({"note":review["note"],"at":review["at"]});
        }
    }
    if data
        .get("acceptanceState")
        .and_then(Value::as_str)
        .is_some_and(|s| ["passed", "failed", "none", "pending", "running"].contains(&s))
    {
        row["acceptanceState"] = data["acceptanceState"].clone();
    }
    if let Some(review) = data.get("review") {
        if review.get("accepted").is_some_and(Value::is_boolean)
            && review.get("at").is_some_and(number)
        {
            row["review"] = json!({"accepted":review["accepted"],"kind":optional_string(review,"kind",64),"note":optional_string(review,"note",1000),"at":review["at"]});
        }
    }
    if data.get("dismissed") == Some(&Value::Bool(true)) {
        row["dismissed"] = json!(true);
    }
    for (key, max) in [
        ("retriedBy", 128),
        ("retryOf", 128),
        ("brokenExecutor", 64),
        ("brokenReason", 500),
    ] {
        if let Some(v) = optional_string(data, key, max) {
            row[key] = json!(v);
        }
    }
    if data.get("attemptStartedAt").is_some_and(number) {
        row["attemptStartedAt"] = data["attemptStartedAt"].clone();
    }
    if let Some(progress) = data.get("progress") {
        if progress.get("phase").is_some_and(Value::is_string)
            && ["files", "commits", "logBytes"]
                .iter()
                .all(|key| progress.get(key).is_some_and(number))
        {
            row["progress"] = json!({"phase":string(progress,"phase",16).unwrap_or_default(),"lastOutputAt":finite(progress,"lastOutputAt"),"files":progress["files"],"commits":progress["commits"],"logBytes":progress["logBytes"]});
        }
    }
    if data.get("runnerAlive").is_some_and(Value::is_boolean) {
        row["runnerAlive"] = data["runnerAlive"].clone();
    }
    Some(row)
}

fn parse_mode(data: &Value) -> Option<Value> {
    let mode = string(data, "mode", 32)?;
    let strategy = string(data, "strategy", 128)?;
    if mode.is_empty() || !data.get("at").is_some_and(number) {
        return None;
    }
    Some(
        json!({"mode":mode,"strategy":strategy,"at":data["at"],"previous":optional_string(data,"previous",32)}),
    )
}

fn parse_alert(data: &Value) -> Value {
    let error = optional_string(data, "error", 1000);
    let level = data
        .get("level")
        .and_then(Value::as_str)
        .filter(|s| ["info", "warn", "error"].contains(s))
        .unwrap_or(if error.is_some() { "error" } else { "info" });
    let mut row = json!({"key":optional_string(data,"key",128).unwrap_or("alert".into()),"level":level,"title":clip(&optional_string(data,"title",4096).unwrap_or("pacer".into()),120),"body":clip(&string(data,"body",4096).or_else(||error.clone()).unwrap_or_default(),1000),"at":finite(data,"at")});
    if row["at"].is_null() {
        row["at"] = json!(0);
    }
    if let Some(error) = error {
        row["error"] = json!(error);
    }
    if let Some(notification) = data.get("notification") {
        if notification
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|s| {
                ["failed", "done", "broken", "quota", "strategy", "session"].contains(&s)
            })
        {
            let mut n = json!({"kind":notification["kind"]});
            for key in ["fromPanel", "near"] {
                if notification.get(key) == Some(&Value::Bool(true)) {
                    n[key] = json!(true);
                }
            }
            for (key, max) in [
                ("executor", 64),
                ("goal", 1000),
                ("nextExecutor", 64),
                ("strategy", 128),
            ] {
                if let Some(v) = optional_string(notification, key, max) {
                    n[key] = json!(v);
                }
            }
            if notification.get("resetsAt").is_some_and(number) {
                n["resetsAt"] = notification["resetsAt"].clone();
            }
            row["notification"] = n;
        }
    }
    row
}

/// The durable envelope parser. Unknown fields are discarded on read, as in the Bun parser.
pub fn parse_outbox_event(raw: &Value) -> Option<Value> {
    let raw = js_json(raw);
    let raw = &raw;
    if raw.get("v").is_some_and(|v| v != 1) {
        return None;
    }
    let kind = raw.get("type")?.as_str()?;
    let data = raw.get("data")?;
    if !data.is_object() {
        return None;
    }
    match kind {
        "entity" => {
            let entity_kind = data.get("kind")?.as_str()?;
            if ![
                "desktop.update",
                "plugin",
                "planner",
                "executor",
                "account",
                "host",
                "repo",
                "counts",
                "attention",
                "activity",
                "job",
                "notify",
                "machine",
                "message",
                "liveness",
            ]
            .contains(&entity_kind)
            {
                return None;
            }
            if !required_string(data, "id", if entity_kind == "notify" { 512 } else { 128 }) {
                return None;
            }
            let mut output = json!({"kind":entity_kind,"id":data["id"]});
            if data.get("removed") == Some(&Value::Bool(true)) {
                output["removed"] = Value::Bool(true);
            } else if let Some(value) = data.get("value") {
                output["value"] = value.clone();
            }
            Some(json!({"type":"entity","data":output}))
        }
        "config"
            if optional_string(data, "area", 128).is_some()
                && data.get("at").is_some_and(number) =>
        {
            Some(
                json!({"type":"config","data":{"area":optional_string(data, "area", 128)?,"at":data["at"]}}),
            )
        }
        "budget" => Some(json!({"type":"budget","data":parse_budget(data)?})),
        "task" => Some(json!({"type":"task","data":parse_task(data)?})),
        "mode" => Some(json!({"type":"mode","data":parse_mode(data)?})),
        "alert" => Some(json!({"type":"alert","data":parse_alert(data)})),
        "pause" if data.get("removed") == Some(&Value::Bool(true)) => {
            Some(json!({"type":"pause","data":{"removed":true}}))
        }
        "pause"
            if data.get("until").is_some_and(|v| v.is_null() || number(v))
                && data
                    .get("reason")
                    .is_some_and(|v| v.is_null() || v.is_string())
                && data.get("by").is_some_and(|v| v.is_null() || v.is_string()) =>
        {
            Some(
                json!({"type":"pause","data":{"until":data["until"],"reason":data["reason"],"by":data["by"]}}),
            )
        }
        "assistant"
            if optional_string(data, "turnId", 128).is_some()
                && optional_string(data, "conversationId", 128).is_some()
                && data
                    .get("state")
                    .and_then(Value::as_str)
                    .is_some_and(|s| ["done", "error", "cancelled"].contains(&s)) =>
        {
            Some(
                json!({"type":"assistant","data":{"turnId":optional_string(data, "turnId", 128)?,"conversationId":optional_string(data, "conversationId", 128)?,"state":data["state"]}}),
            )
        }
        "discovery.found"
            if data
                .get("discoveryId")
                .and_then(Value::as_str)
                .is_some_and(|id| {
                    id.len() == 26
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
                })
                && data.get("name").is_some_and(Value::is_string)
                && data.get("version").is_some_and(Value::is_string) =>
        {
            Some(
                json!({"type":"discovery.found","data":{"discoveryId":data["discoveryId"],"name":string(data,"name",64),"version":string(data,"version",32)}}),
            )
        }
        _ => None,
    }
}

pub fn read_latest(ctx: &Ctx) -> Value {
    let raw = pacer_foundation::fsutil::read_json::<Value>(&latest_path(ctx));
    raw.as_ref()
        .and_then(parse_snapshot)
        .unwrap_or_else(empty_snapshot)
}

fn parse_console(raw: &Value) -> Option<Value> {
    if !["pid", "startedAt", "heartbeatAt"]
        .iter()
        .all(|key| raw.get(key).is_some_and(number))
    {
        return None;
    }
    let mut value = json!({});
    if let Some(version) = optional_string(raw, "version", 64) {
        value["version"] = json!(version);
    }
    if let Some(id) = optional_string(raw, "worktreeId", 1024) {
        value["worktreeId"] = json!(id);
    }
    value["pid"] = raw["pid"].clone();
    value["startedAt"] = raw["startedAt"].clone();
    value["heartbeatAt"] = raw["heartbeatAt"].clone();
    if raw.get("busyUntil").is_some_and(number) {
        value["busyUntil"] = raw["busyUntil"].clone();
    }
    value["handle"] = optional_string(raw, "handle", 1024).map_or(Value::Null, Value::String);
    value["paneKey"] = optional_string(raw, "paneKey", 2048).map_or(Value::Null, Value::String);
    Some(value)
}

pub fn parse_snapshot(raw: &Value) -> Option<Value> {
    let raw = js_json(raw);
    let raw = &raw;
    let seq = safe_integer(raw.get("seq")?)?;
    if raw.get("v") != Some(&json!(1)) || !raw.get("at").is_some_and(number) {
        return None;
    }
    let mut snapshot = json!({"v":1,"seq":seq,"at":raw["at"]});
    if raw.get("serviceInstalled").is_some_and(Value::is_boolean) {
        snapshot["serviceInstalled"] = raw["serviceInstalled"].clone();
    }
    snapshot["budget"] = raw
        .get("budget")
        .and_then(parse_budget)
        .unwrap_or(Value::Null);
    snapshot["mode"] = raw.get("mode").and_then(parse_mode).unwrap_or(Value::Null);
    snapshot["tasks"] = Value::Array(
        raw.get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(parse_task)
            .take(20)
            .collect(),
    );
    snapshot["alerts"] = Value::Array(
        raw.get("alerts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|v| v.is_object())
            .map(parse_alert)
            .take(10)
            .collect(),
    );
    snapshot["console"] = raw
        .get("console")
        .and_then(parse_console)
        .unwrap_or(Value::Null);
    snapshot["consoles"] = Value::Array(
        raw.get("consoles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(parse_console)
            .take(32)
            .collect(),
    );
    snapshot["strategies"] = Value::Array(raw.get("strategies").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        if let Some(name) = item.as_str() { return Some(slice_utf16(name, 128)).filter(|name| !name.is_empty()).map(Value::String); }
        let name = optional_string(item,"name",128)?;
        Some(json!({"name":name,"active":item.get("active")==Some(&Value::Bool(true)),"summary":string(item,"summary",1000).unwrap_or_default(),"description":string(item,"description",1000).unwrap_or_default()}))
    }).take(32).collect());
    Some(snapshot)
}

/// Applies a durable event to the compatibility snapshot without changing console/Orca fields.
pub fn reduce(snapshot: &Value, event: &Value, at: f64) -> Value {
    let mut next = snapshot.clone();
    // JS reduces with Number addition. Round at the same binary64 boundary,
    // including after MAX_SAFE_INTEGER, before storing the JSON integer.
    let seq = (snapshot["seq"].as_f64().unwrap_or(0.0) + 1.0) as u64;
    next["seq"] = json!(seq);
    next["at"] = js_number(at);
    match event["type"].as_str().unwrap_or("") {
        "budget" => next["budget"] = event["data"].clone(),
        "mode" => next["mode"] = event["data"].clone(),
        "task" => {
            let mut tasks = vec![event["data"].clone()];
            tasks.extend(
                snapshot["tasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|t| t["id"] != event["data"]["id"])
                    .cloned(),
            );
            tasks.sort_by(|a, b| {
                b["updatedAt"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a["updatedAt"].as_f64().unwrap_or(0.0))
            });
            tasks.truncate(20);
            next["tasks"] = Value::Array(tasks);
        }
        "alert" => {
            let mut alerts = vec![event["data"].clone()];
            alerts.extend(
                snapshot["alerts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|a| a["key"] != event["data"]["key"])
                    .cloned(),
            );
            alerts.sort_by(|a, b| {
                b["at"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a["at"].as_f64().unwrap_or(0.0))
            });
            alerts.truncate(10);
            next["alerts"] = Value::Array(alerts);
        }
        _ => {}
    }
    next
}

/// Callers hold the shared `link` lock before appending and updating `latest.json`.
pub fn append_outbox(ctx: &Ctx, entries: &[Value]) -> io::Result<()> {
    append_outbox_inner(ctx, entries, true)
}

pub(crate) fn append_outbox_for_publish(ctx: &Ctx, entries: &[Value]) -> io::Result<()> {
    append_outbox_inner(ctx, entries, false)
}

fn append_outbox_inner(ctx: &Ctx, entries: &[Value], rotate: bool) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let path = outbox_path(ctx);
    let mut bytes = Vec::new();
    for entry in entries {
        let mut row = json!({"seq":entry["seq"]});
        if let Some(at) = entry.get("at") {
            row["at"] = at.clone();
        }
        row["envelope"] =
            json!({"type":entry["envelope"]["type"],"data":entry["envelope"]["data"]});
        bytes.extend(json_bytes(&row)?);
        bytes.push(b'\n');
    }
    append_publication(&path, &bytes)?;
    if rotate {
        rotate_outbox(ctx)?;
    }
    Ok(())
}

pub(crate) fn rotate_outbox(ctx: &Ctx) -> io::Result<()> {
    let path = outbox_path(ctx);
    let content = fs::read(&path)?;
    let lines: Vec<&[u8]> = content
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    if content.len() as u64 > OUTBOX_MAX_BYTES || lines.len() > OUTBOX_KEEP {
        let mut kept = Vec::new();
        for line in lines.iter().rev().take(OUTBOX_KEEP).rev() {
            kept.extend_from_slice(line);
            kept.push(b'\n');
        }
        atomic_publication(&path, &kept)?;
    }
    Ok(())
}

pub fn read_outbox_since(ctx: &Ctx, seq: f64) -> io::Result<Vec<Value>> {
    let content = match fs::read(outbox_path(ctx)) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for line in content.lines() {
        let Ok(raw) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(value) = raw.get("seq").and_then(Value::as_f64) else {
            continue;
        };
        if value <= seq {
            continue;
        }
        let Some(envelope) = raw.get("envelope").and_then(parse_outbox_event) else {
            continue;
        };
        let mut row = json!({"seq":raw["seq"]});
        if raw.get("at").is_some_and(Value::is_number) {
            row["at"] = raw["at"].clone();
        }
        row["envelope"] = envelope;
        out.push(row);
    }
    Ok(out)
}

pub(crate) fn write_latest(ctx: &Ctx, snapshot: &Value) -> io::Result<()> {
    atomic_publication(&latest_path(ctx), &json_bytes(snapshot)?)
}
