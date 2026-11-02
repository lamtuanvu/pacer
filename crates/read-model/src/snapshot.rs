use crate::{Error, attention, capacity, events::V3_CURSOR_BASE, js::*, read, summary, tasks};
use pacer_config::strategy::{list_strategy_reads, load_strategy, validate_strategy};
use pacer_foundation::Ctx;
use pacer_store::{TaskFilter, TaskStore, read_latest};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
/// External domain probes. `setup` is the deferred setup checklist, not a
/// snapshot. It is updated here with current status and task review facts.
#[derive(Clone)]
pub struct Probes {
    pub setup: Value,
    pub policy: Value,
    pub machine: Value,
    pub service: Value,
    pub desktop_updates: Vec<Value>,
    pub service_installed: bool,
    pub can_pair: bool,
}
pub enum StatusInput {
    Provided(Value),
    Failure(String),
    Cached,
}
pub struct SnapshotInput<'a> {
    pub probes: &'a Probes,
    pub status: StatusInput,
    pub max_budget_age_s: f64,
}
impl<'a> SnapshotInput<'a> {
    pub fn new(probes: &'a Probes, status: StatusInput) -> Self {
        Self {
            probes,
            status,
            max_budget_age_s: 60.0,
        }
    }
}
pub struct SnapshotResult {
    pub snapshot: Value,
    legacy: Value,
    questions: HashMap<String, String>,
}
impl SnapshotResult {
    pub fn wire(&self, protocol: u8) -> Value {
        let snapshot = if protocol == 2 {
            self.v2()
        } else {
            self.snapshot.clone()
        };
        json!({
        "protocol":if protocol==2{
        "2.8.0"}
        else{
        "3.0.0"}
        ,"seq":snapshot["seq"],"snapshot":snapshot}
        )
    }
    /// Exact JSON.stringify wire bytes, including UTF-16 substring boundaries.
    pub fn json(&self, protocol: u8) -> String {
        let value = self.wire(protocol);
        let tasks = array(&value["snapshot"]["tasks"]);
        let attention = array(&value["snapshot"]["attention"]);
        let mut doc = crate::wire::Document::new(value.clone());
        crate::wire::task_strings(&mut doc, tasks, "/snapshot/tasks", &self.questions);
        crate::wire::attention_strings(
            &mut doc,
            attention,
            "/snapshot/attention",
            &self.questions,
            tasks,
        );
        doc.json()
    }
    pub fn v2(&self) -> Value {
        let mut s = self.snapshot.clone();
        remove(&mut s, "desktopUpdates");
        let setup = summary::legacy_setup(&s["setup"]);
        let mut items: Vec<_> = array(&s["attention"])
            .iter()
            .filter_map(|a| {
                if a["id"] == "setup:connect" || crate::events::discovery_id(&a["id"]) {
                    return None;
                }
                let mut a = a.clone();
                let id = if a["id"] == "setup:planner" {
                    "setup:strategy"
                } else {
                    text(&a["id"])
                };
                if let Some(i) = array(&setup["items"])
                    .iter()
                    .find(|i| format!("setup:{}", text(&i["id"])) == id)
                {
                    if i["status"] == "done" {
                        return None;
                    }
                    a["id"] = json!(id);
                    a["title"] = i["title"].clone();
                    let actions: Vec<_> = array(&a["actions"])
                        .iter()
                        .map(|a| {
                            let mut a = a.clone();
                            if a["op"] == "ui.open" {
                                a["params"]["section"] = i["id"].clone();
                            }
                            a
                        })
                        .collect();
                    a["actions"] = json!(actions);
                }
                Some(a)
            })
            .collect();
        attention::sort(&mut items);
        s["counts"]["attention"] = json!(items.len());
        s["counts"]["problems"] = json!(items.iter().filter(|a| a["severity"] != "decide").count());
        s["counts"]["setupOpen"] = setup["open"].clone();
        s["attention"] = json!(items);
        s["setup"] = setup;
        if s["machine"]["unlimited"] == true {
            let max = array(&s["executors"])
                .iter()
                .filter(|e| e["rank"] != "planner" && e["host"].is_null() && truth(&e["enabled"]))
                .map(|e| num(&e["slots"]["max"]))
                .sum::<f64>()
                .max(1.0);
            s["machine"]["max"] = number(max);
        }
        if num(&s["seq"]) >= V3_CURSOR_BASE {
            s["seq"] = number(num(&s["seq"]) - V3_CURSOR_BASE);
        }
        s["v"] = json!(1);
        for key in [
            "budget",
            "alerts",
            "console",
            "consoles",
            "serviceInstalled",
        ] {
            s[key] = self.legacy[key].clone();
        }
        s["service"]["protocol"] = json!("2.8.0");
        s
    }
}
struct CachedStatus {
    at: f64,
    key: String,
    value: Value,
}
struct CachedTasks {
    at: f64,
    version: String,
    records: Vec<Value>,
}
/// Instance-owned caches, keyed by home. No process-global cache crosses fixture
/// homes; backwards clock movement invalidates task/status/context cache hits.
#[derive(Default)]
pub struct ReadModel {
    consoles: crate::consoles::Consoles,
    stores: HashMap<PathBuf, TaskStore>,
    statuses: HashMap<PathBuf, CachedStatus>,
    tasks: HashMap<PathBuf, CachedTasks>,
    contexts: HashMap<PathBuf, (f64, Value)>,
}
impl ReadModel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn store(&mut self, ctx: &Ctx) -> Result<&mut TaskStore, Error> {
        if !self.stores.contains_key(&ctx.pacer_home) {
            self.stores
                .insert(ctx.pacer_home.clone(), TaskStore::open(&ctx.pacer_home)?);
        }
        self.stores
            .get_mut(&ctx.pacer_home)
            .ok_or_else(|| std::io::Error::other("task store not initialized").into())
    }
    pub fn snapshot(
        &mut self,
        ctx: &Ctx,
        input: SnapshotInput<'_>,
        zone: chrono_tz::Tz,
        alive: &dyn Fn(i64) -> bool,
    ) -> Result<SnapshotResult, Error> {
        let mut legacy = read_latest(ctx);
        let version = self.store(ctx)?.version()?;
        let records = if let Some(cache) = self
            .tasks
            .get(&ctx.pacer_home)
            .filter(|cache| cache.version == version && ctx.now >= cache.at)
        {
            cache.records.clone()
        } else {
            let store = self.store(ctx)?;
            let mut selected = store.list(&TaskFilter {
                updated_since: Some(ctx.now - 86400.0),
                ..Default::default()
            })?;
            for t in store.list(&TaskFilter {
                states: Some(&["queued", "running"]),
                ..Default::default()
            })? {
                if let Some(old) = selected.iter_mut().find(|r| r["id"] == t["id"]) {
                    *old = t;
                } else {
                    selected.push(t);
                }
            }
            selected.sort_by(|a, b| text(&b["id"]).cmp(text(&a["id"])));
            self.tasks.insert(
                ctx.pacer_home.clone(),
                CachedTasks {
                    at: ctx.now,
                    version,
                    records: selected.clone(),
                },
            );
            selected
        };
        let records: Vec<_> = records
            .into_iter()
            .filter(|t| {
                if ["queued", "running"].contains(&text(&t["state"])) {
                    return true;
                }
                let last = array(&t["attempts"])
                    .iter()
                    .map(|a| num(&a["endedAt"]))
                    .fold(0.0, f64::max);
                num(&t["createdAt"])
                    .max(num(&t["attemptStartedAt"]))
                    .max(last)
                    >= ctx.now - 86400.0
            })
            .collect();
        let tasks = tasks::snapshot_tasks(ctx, &records, self.store(ctx)?, alive)?;
        let snapshot_tasks: Vec<_> = tasks
            .iter()
            .map(|t| {
                merge(
                    array(&legacy["tasks"])
                        .iter()
                        .find(|old| old["id"] == t["id"])
                        .unwrap_or(&Value::Null),
                    t,
                )
            })
            .collect();
        let strategy = load_strategy(&ctx.pacer_home).unwrap_or_else(|_| {
            let mut s = validate_strategy(
                &json!({
                "planner":"claude-code","providers":{
                "claude-code":{
                }
                }
                }
                ),
                Path::new("snapshot"),
                "snapshot",
            )
            .unwrap_or_else(|_| object());
            for k in ["runners", "accounts", "providers"] {
                s[k] = object();
            }
            s["routing"] = json!([]);
            s
        });
        let hold = read_hold(ctx);
        let key = stringify(&json!([strategy, hold]));
        let cache = self.statuses.get(&ctx.pacer_home);
        let mut available = false;
        let mut warming = false;
        let mut status = match input.status {
            StatusInput::Provided(st) => {
                available = true;
                self.statuses.insert(
                    ctx.pacer_home.clone(),
                    CachedStatus {
                        at: ctx.now,
                        key: key.clone(),
                        value: st.clone(),
                    },
                );
                st
            }
            StatusInput::Cached => {
                if let Some(cache) = cache.filter(|c| {
                    c.key == key && ctx.now >= c.at && ctx.now - c.at < input.max_budget_age_s
                }) {
                    available = true;
                    cache.value.clone()
                } else {
                    return Err(std::io::Error::other(
                        "fresh status input required after cache expiry or strategy/hold change",
                    )
                    .into());
                }
            }
            StatusInput::Failure(message) => {
                warming = message == "status is warming up";
                let planner = legacy["budget"]["planner"]
                    .as_str()
                    .map(String::from)
                    .or_else(|| {
                        values(&strategy["runners"])
                            .into_iter()
                            .find(|r| {
                                r["agent"] == strategy["planner"]["agent"]
                                    && r["account"] == strategy["planner"]["account"]
                            })
                            .map(|r| text(&r["id"]).into())
                    })
                    .unwrap_or_default();
                json!({
                "generatedAt":number(ctx.now),"strategy":strategy["name"],"planner":planner,"mode":"normal","disabled":false,"calendarPace":false,"providers":[],"executors":{
                "ranked":[],"excluded":[]}
                }
                )
            }
        };
        let mode = if !hold.is_null() {
            text(&hold["mode"])
        } else {
            let p = array(&status["providers"])
                .iter()
                .find(|p| p["id"] == status["planner"])
                .unwrap_or(&Value::Null);
            match text(&p["verdict"]) {
                "EXHAUSTED" => "emergency",
                "AHEAD" | "NEAR_LIMIT" => "strict",
                "BEHIND" | "EXPIRING" => "relaxed",
                _ => "normal",
            }
        }
        .to_owned();
        status["modeHold"] = hold;
        status["mode"] = json!(mode);
        if available
            && (legacy["budget"].is_null()
                || ctx.now - num(&legacy["budget"]["generatedAt"]) > input.max_budget_age_s)
        {
            legacy["budget"] = capacity::budget(&status);
        }
        let p = input.probes;
        let executors = capacity::executors(ctx, &status, &strategy, &tasks);
        let accounts = capacity::accounts_in_home(ctx, &status, &strategy);
        let planner = capacity::planner(&status, zone);
        let hosts = summary::hosts(ctx, &strategy, &executors, &tasks);
        let checklist = if let Some((at, value)) = self
            .contexts
            .get(&ctx.pacer_home)
            .filter(|(at, _)| ctx.now >= *at && ctx.now - *at < 5.0)
        {
            let _ = at;
            value.clone()
        } else {
            self.contexts
                .insert(ctx.pacer_home.clone(), (ctx.now, p.setup.clone()));
            p.setup.clone()
        };
        let setup = summary::setup(
            &checklist,
            &status,
            tasks.iter().any(|t| truth(&t["review"])),
            ctx.pacer_home.join("onboarding/skipped").exists(),
            &p.policy,
        );
        let attention = attention::derive(
            ctx, &tasks, &executors, &accounts, &setup, &planner, p.can_pair,
        );
        let mut repos = tasks::registered_repos(ctx);
        for t in &tasks {
            if !repos.iter().any(|r| r["key"] == t["repo"]["key"]) {
                repos.push(t["repo"].clone());
            }
        }
        let used = tasks
            .iter()
            .filter(|t| {
                t["state"] == "running"
                    && t["host"].is_null()
                    && strategy["runners"][text(&t["executor"])]["host"].is_null()
            })
            .count();
        let cap = strategy["execution"]["local_max_tasks"].clone();
        let mut machine = object();
        for k in ["os", "arch"] {
            if let Some(v) = p.machine.get(k) {
                machine[k] = v.clone();
            }
        }
        machine = merge(
            &machine,
            &json!({
            "used":used,"max":cap.as_f64().map_or(number(9007199254740991.0),number),"hardCap":cap,"unlimited":cap.is_null()}
            ),
        );
        for k in [
            "memoryPressure",
            "memoryPressureLimit",
            "loadPerCore",
            "loadLimit",
            "open",
            "reason",
            "detail",
        ] {
            if let Some(v) = p.machine.get(k) {
                machine[k] = v.clone();
            }
        }
        let mut service = p.service.clone();
        if warming {
            service["starting"] = json!(true);
        }
        let strategies = list_strategy_reads(&ctx.pacer_home).unwrap_or(json!([]));
        let snapshot = json!({
        "seq":number(V3_CURSOR_BASE+num(&legacy["seq"])),"at":legacy["at"],"mode":legacy["mode"],"policy":p.policy,"desktopUpdates":p.desktop_updates,"machine":machine,"pause":read_pause(ctx),"attention":attention,"service":service,"planner":planner,"executors":executors,"accounts":accounts,"hosts":hosts,"repos":repos,"setup":setup,"counts":summary::counts(&tasks,&executors,&setup,&hosts,&attention),"today":summary::today(ctx.now,&tasks,zone),"tasks":snapshot_tasks,"strategies":strategies}
        );
        let (console, consoles) = self.consoles.read(ctx, text(&p.service["version"]), alive);
        legacy["console"] = console;
        legacy["consoles"] = json!(consoles);
        legacy["serviceInstalled"] = json!(p.service_installed);
        let questions = crate::wire::questions(self.store(ctx)?)?;
        Ok(SnapshotResult {
            snapshot,
            legacy,
            questions,
        })
    }
}
fn read_hold(ctx: &Ctx) -> Value {
    let hold = read(ctx, "state/mode-hold.json");
    if ["strict", "normal", "relaxed", "emergency"].contains(&text(&hold["mode"]))
        && hold["until"].as_f64().is_some_and(|n| n > ctx.now)
    {
        hold
    } else {
        Value::Null
    }
}
fn read_pause(ctx: &Ctx) -> Value {
    let mut pause = read(ctx, "state/pause.json");
    if !pause.is_object()
        || pause.get("until").is_none()
        || (!pause["until"].is_null() && !pause["until"].as_f64().is_some_and(|n| n > ctx.now))
        || ["reason", "by"]
            .iter()
            .any(|k| pause.get(k).is_none() || !pause[k].is_null() && !pause[k].is_string())
    {
        return Value::Null;
    }
    for key in ["reason", "by"] {
        if let Some(s) = pause[key].as_str() {
            let mut s = s.to_owned();
            let mut secrets: Vec<_> = ctx
                .env
                .iter()
                .filter(|(key, value)| {
                    !value.is_empty()
                        && ["key", "token", "secret", "password"]
                            .iter()
                            .any(|word| key.to_ascii_lowercase().contains(word))
                })
                .map(|(_, value)| value)
                .collect();
            secrets.sort_by_key(|secret| std::cmp::Reverse(secret.encode_utf16().count()));
            for secret in secrets {
                s = s.replace(secret, "[redacted]");
            }
            pause[key] = json!(capacity::redact(&s));
        }
    }
    pause
}
