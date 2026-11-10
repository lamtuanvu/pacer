//! Pure replay and SSE lifecycle. The transport calls poll on a writer wake or
//! its tail interval, and heartbeat at 15 seconds; cancellation releases state.
use crate::{Error, capacity, js::*, tasks};
use pacer_foundation::Ctx;
use pacer_store::{TaskStore, read_outbox_replay};
use serde_json::{Value, json};

pub const V3_CURSOR_BASE: f64 = 3_000_000_000_000.0;
pub const CONNECTED: &str = ": connected\n\n";
pub const KEEPALIVE: &str = ": keepalive\n\n";
pub fn parse_cursor(header: Option<&str>, query: Option<&str>) -> Result<f64, Error> {
    let s = trim(header.or(query).unwrap_or("0"));
    let n = if s.is_empty() {
        0.0
    } else if let Some(s) = s.strip_prefix("0x").or(s.strip_prefix("0X")) {
        u64::from_str_radix(s, 16)
            .map(|n| n as f64)
            .unwrap_or(f64::NAN)
    } else if let Some(s) = s.strip_prefix("0b").or(s.strip_prefix("0B")) {
        u64::from_str_radix(s, 2)
            .map(|n| n as f64)
            .unwrap_or(f64::NAN)
    } else if let Some(s) = s.strip_prefix("0o").or(s.strip_prefix("0O")) {
        u64::from_str_radix(s, 8)
            .map(|n| n as f64)
            .unwrap_or(f64::NAN)
    } else if s.chars().any(|c| c.is_whitespace()) {
        f64::NAN
    } else {
        s.parse::<f64>().unwrap_or(f64::NAN)
    };
    if n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n) {
        Ok(n)
    } else {
        Err(Error::Cursor)
    }
}
pub fn discovery_id(v: &Value) -> bool {
    let id = text(v);
    id.starts_with("discovery:") || id.starts_with("discovery-network:")
}
pub fn v3_only(e: &Value) -> bool {
    let d = &e["data"];
    match text(&e["type"]) {
        "discovery.found" => true,
        "config" => d["area"] == "discovery",
        "attention" => discovery_id(&d["id"]),
        "notify" => discovery_id(&d["key"]),
        _ => false,
    }
}
pub fn to_v2_event(e: &Value) -> Option<Value> {
    if [
        "desktop.update",
        "planner",
        "assistant",
        "machine",
        "message",
        "discovery.found",
    ]
    .contains(&text(&e["type"]))
        || e["type"] == "config" && ["machine", "discovery"].contains(&text(&e["data"]["area"]))
    {
        return None;
    }
    let mut out = e.clone();
    out["seq"] = number(if num(&e["seq"]) >= V3_CURSOR_BASE {
        num(&e["seq"]) - V3_CURSOR_BASE
    } else {
        num(&e["seq"])
    });
    Some(out)
}
pub fn events_since(
    ctx: &Ctx,
    since: f64,
    protocol: u8,
    store: &mut TaskStore,
    zone: chrono_tz::Tz,
    alive: &dyn Fn(i64) -> bool,
) -> Result<Value, Error> {
    let old = protocol == 3 && since > 0.0 && since < V3_CURSOR_BASE;
    let raw_since = if protocol == 3 {
        if since >= V3_CURSOR_BASE {
            since - V3_CURSOR_BASE
        } else {
            0.0
        }
    } else {
        since
    };
    let replay = read_outbox_replay(ctx, raw_since)?;
    let at = replay.discovery_at_counts;
    let oldest = replay.oldest;
    let reset = raw_since > 0.0 && oldest.is_some_and(|n| n > raw_since + 1.0);
    let after = replay.entries;
    let mut records = Vec::new();
    for e in &after {
        if e["envelope"]["type"] == "task" {
            let id = text(&e["envelope"]["data"]["id"]);
            if !records.iter().any(|r: &Value| r["id"] == id)
                && let Some(r) = store.read(id)?
            {
                records.push(r);
            }
        }
    }
    let enriched = if records.is_empty() {
        Vec::new()
    } else {
        tasks::api_tasks(ctx, &crate::ActiveCounts::default(), &records, store, alive)?
    };
    let mut raw = Vec::new();
    if reset {
        raw.push(json!({
        "seq":number(oldest.unwrap_or(0.0)-1.0),"at":number(ctx.now),"type":"reset","data":{
        "reason":"events were dropped; fetch the snapshot again"}
        }
        ));
    }
    for e in &after {
        let env = &e["envelope"];
        let kind = text(&env["type"]);
        let mut data = env["data"].clone();
        let mut kind = kind.to_string();
        if kind == "entity" {
            kind = text(&data["kind"]).to_owned();
            data = if truth(&data["removed"]) {
                json!({
                "id":data["id"],"removed":true}
                )
            } else {
                data["value"].clone()
            };
        }
        if kind == "task" {
            if let Some(t) = enriched.iter().find(|t| t["id"] == data["id"]) {
                for k in ["repo", "kind", "host", "title", "fullTitle", "messages"] {
                    if let Some(v) = t.get(k) {
                        data[k] = v.clone();
                    }
                }
            } else {
                let fake = json!({
                "title":data["title"],"brief":{
                "goal":data["goal"]}
                }
                );
                if !truth(&data["title"]) {
                    data["title"] = json!(tasks::goal_title(text(&data["goal"]), true));
                }
                data["fullTitle"] = json!(tasks::full_title(&fake));
            }
        }
        raw.push(json!({
        "seq":e["seq"],"at":e.get("at").cloned().unwrap_or(number(ctx.now)),"type":kind,"data":data}
        ));
    }
    let last = after.last().map_or(raw_since, |e| num(&e["seq"]));
    let mut converted = Vec::new();
    for e in raw {
        if protocol == 2 {
            if e["type"] == "planner" || e["type"] == "desktop.update" || v3_only(&e) {
                continue;
            }
            {
                // Replay carries V2_EVENT in TS: preserve the raw legacy payload,
                // including families excluded by standalone toV2Event.
                let mut v = e.clone();
                if e["type"] == "counts" {
                    let n = at.get(&(num(&e["seq"]) as i64)).copied().unwrap_or(0);
                    if n > 0 && e["data"]["attention"].is_number() {
                        v["data"]["attention"] =
                            number((num(&e["data"]["attention"]) - n as f64).max(0.0));
                    }
                }
                converted.push(v);
            }
            continue;
        }
        let mut v = e.clone();
        v["seq"] = number(V3_CURSOR_BASE + num(&e["seq"]));
        match text(&e["type"]) {
            "budget" => {
                let b = &e["data"];
                let providers:Vec<_>=array(&b["providers"]).iter().map(|p|{
let mut p=p.clone();
if !p["usedPct"].is_null(){
let binding=json!({
"name":p["window"].as_str().unwrap_or("unknown"),"usedPct":p["usedPct"],"pace":p["pacePct"],"resetsAt":p["resetsAt"]}
);
p["binding"]=binding;
}
p}
).collect();
                v["type"] = json!("planner");
                v["data"] = capacity::planner(
                    &json!({
                    "planner":b["planner"],"mode":b["mode"],"providers":providers}
                    ),
                    zone,
                );
            }
            "alert" => {
                let a = &e["data"];
                v["type"] = json!("notify");
                v["data"] = json!({
                "key":format!("{}:{}",text(&a["key"]),stringify(&a["at"])),"title":a["title"],"body":a["body"],"actions":[],"url":"/app/#/"}
                );
            }
            _ => {}
        }
        converted.push(v);
    }
    if old {
        converted.insert(
            0,
            json!({
            "seq":number(V3_CURSOR_BASE),"at":number(ctx.now),"type":"reset","data":{
            "reason":"protocol changed; fetch the snapshot again"}
            }
            ),
        );
    }
    let mut result = json!({
    "events":converted,"last":number(if protocol==3{
    V3_CURSOR_BASE+last}
    else{
    last}
    ),"reset":old||reset}
    );
    if protocol == 2 {
        result["discoveryOpen"] = json!({});
    }
    Ok(result)
}
pub fn events_document(
    ctx: &Ctx,
    since: f64,
    protocol: u8,
    store: &mut TaskStore,
    zone: chrono_tz::Tz,
    alive: &dyn Fn(i64) -> bool,
) -> Result<crate::wire::Document, Error> {
    let value = events_since(ctx, since, protocol, store, zone, alive)?;
    let needs_questions = array(&value["events"])
        .iter()
        .any(|e| e["type"] == "task" && !e["data"]["messages"]["question"].is_null());
    let questions = if needs_questions {
        crate::wire::questions(store)?
    } else {
        Default::default()
    };
    let mut doc = crate::wire::Document::new(value.clone());
    for (i, e) in array(&value["events"]).iter().enumerate() {
        if e["type"] == "task"
            && let Some(body) = questions.get(text(&e["data"]["messages"]["question"]["id"]))
            && !e["data"]["messages"]["question"].is_null()
        {
            doc.substring(
                format!("/events/{i}/data/messages/question/text"),
                body,
                1000,
            );
        }
    }
    Ok(doc)
}
pub fn frame(e: &Value) -> String {
    format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        stringify(&e["seq"]),
        text(&e["type"]),
        stringify(&e["data"])
    )
}
/// No timers or subscriptions are installed by the library. Owners schedule one
/// poll interval and one heartbeat, and drop them when cancel() is called.
pub struct SseCursor {
    last: f64,
    protocol: u8,
    closed: bool,
    next_heartbeat: f64,
}
impl SseCursor {
    pub fn new(
        header: Option<&str>,
        query: Option<&str>,
        protocol: u8,
        now_ms: f64,
    ) -> Result<Self, Error> {
        Ok(Self {
            last: parse_cursor(header, query)?,
            protocol,
            closed: false,
            next_heartbeat: now_ms + 15000.0,
        })
    }
    pub fn last(&self) -> f64 {
        self.last
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub fn cancel(&mut self) {
        self.closed = true;
    }
    pub fn heartbeat(&mut self, now_ms: f64) -> Option<&'static str> {
        if !self.closed && now_ms >= self.next_heartbeat {
            self.next_heartbeat = now_ms + 15000.0;
            Some(KEEPALIVE)
        } else {
            None
        }
    }
    pub fn poll(
        &mut self,
        ctx: &Ctx,
        store: &mut TaskStore,
        zone: chrono_tz::Tz,
        alive: &dyn Fn(i64) -> bool,
    ) -> Result<String, Error> {
        if self.closed {
            return Ok(String::new());
        }
        let result = events_document(ctx, self.last, self.protocol, store, zone, alive);
        match result {
            Ok(batch) => {
                self.last = num(&batch.value["last"]);
                Ok(array(&batch.value["events"])
                    .iter()
                    .enumerate()
                    .map(|(i, e)| {
                        let data = batch.at(&format!("/events/{i}/data"));
                        format!(
                            "id: {}\nevent: {}\ndata: {}\n\n",
                            stringify(&e["seq"]),
                            text(&e["type"]),
                            data.json()
                        )
                    })
                    .collect())
            }
            Err(e) => {
                self.cancel();
                Err(e)
            }
        }
    }
}
