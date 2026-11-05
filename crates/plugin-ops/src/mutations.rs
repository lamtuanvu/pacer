//! Plugin mutation orchestration (X3 library; P4d-3 HTTP wiring).
//!
//! `PublicRegistry` still exposes only the four reads. HTTP serve registers these
//! mutation ops through a `MutationRuntime` adapter over Core private IPC
//! (`/_internal/plugins` stop/changed/call/publish/log). Stdio stays TypeScript.
#![allow(clippy::result_large_err)]
use crate::{
    config::{edit_config, read_config},
    public::Entry,
    settings, ui,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
/// Mutation ops characterized here; HTTP serve registers all but `plugin.install`.
pub const MUTATION_OPERATIONS: &[&str] = &[
    "plugin.enable",
    "plugin.disable",
    "plugin.remove",
    "plugin.ui.render",
    "plugin.ui.action",
    "plugin.ui.visibility",
    "plugin.settings.set",
    "plugin.install",
];
/// Process-owner effects required by mutations; not implemented by the HTTP read adapter.
pub trait MutationRuntime: Send {
    fn refresh(&mut self, ctx: &Ctx) -> Result<Vec<Entry>, CoreError>;
    fn call<'a>(
        &'a mut self,
        ctx: &'a Ctx,
        id: &'a str,
        method: &'a str,
        params: Value,
    ) -> OpFuture<'a>;
    fn stop<'a>(&'a mut self, ctx: &'a Ctx, id: &'a str) -> OpFuture<'a>;
    fn reset(&mut self, id: &str);
    fn changed<'a>(&'a mut self, ctx: &'a Ctx, id: &'a str, invalidate: bool) -> OpFuture<'a>;
    fn log(&mut self, ctx: &Ctx, id: &str, message: &str);
}
#[derive(Clone)]
struct Cached {
    document: Value,
    at: f64,
    ttl: f64,
}
#[derive(Default)]
struct UiState {
    cache: VecDeque<(String, Cached)>,
    renders: HashMap<String, Vec<f64>>,
    actions: Vec<f64>,
    inflight: Arc<Mutex<HashSet<String>>>,
    invalid_logs: HashMap<String, f64>,
}
struct InFlight {
    set: Arc<Mutex<HashSet<String>>>,
    id: String,
}
impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.id);
        }
    }
}
#[derive(Default)]
pub struct MutationOperations {
    ui: Mutex<HashMap<String, UiState>>,
}
fn valid_plugin_id(id: &str) -> bool {
    id.len() >= 2
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn find(entries: &[Entry], id: &str) -> Result<Entry, CoreError> {
    entries
        .iter()
        .find(|e| e.id == id)
        .cloned()
        .ok_or_else(|| CoreError::new(Code::UnknownPlugin, format!("unknown plugin {id}")))
}
fn page(e: &Entry) -> Result<Value, CoreError> {
    let page = e.surfaces("settings").first().ok_or_else(|| {
        CoreError::new(
            Code::NotFound,
            format!("plugin {} has no settings page", e.id),
        )
    })?;
    if !e.available() && e.state != "failing" {
        return Err(CoreError::new(
            Code::PluginUnavailable,
            format!("plugin {} is {}", e.id, e.state),
        ));
    }
    Ok(page.clone())
}
fn settings_error(id: &str, errors: Vec<Value>) -> CoreError {
    let message = errors
        .iter()
        .take(3)
        .map(|e| {
            format!(
                "{} {}",
                e["path"].as_str().unwrap_or(""),
                e["message"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    CoreError::new(
        Code::InvalidInput,
        format!("plugin {id} settings are invalid: {message}"),
    )
    .data(serde_json::Map::from_iter([(
        "errors".into(),
        json!(errors.into_iter().take(50).collect::<Vec<_>>()),
    )]))
}
fn now() -> f64 {
    (pacer_foundation::ctx::unix_now() * 1000.0).floor()
}
fn kind(surface: &str) -> &str {
    if surface == "panelTab" {
        "panelTabs"
    } else {
        surface
    }
}
fn string<'a>(p: &'a Value, name: &str) -> Result<&'a str, CoreError> {
    p[name].as_str().ok_or_else(|| {
        CoreError::new(
            Code::InvalidInput,
            format!("{name}: Invalid input: expected string"),
        )
    })
}
fn params(op: &str, p: &Value) -> Result<(), CoreError> {
    let bad = |s: &str| CoreError::new(Code::InvalidInput, s);
    if !p.is_object() {
        let received = match p {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        };
        return Err(CoreError::new(
            Code::InvalidInput,
            format!("params: Invalid input: expected object, received {received}"),
        ));
    }
    if op != "plugin.install" {
        let key = if op.starts_with("plugin.ui.") || op.starts_with("plugin.settings.") {
            "plugin"
        } else {
            "id"
        };
        if !(op == "plugin.doctor" && p.get(key).is_none()) {
            let id = string(p, key)?;
            if !valid_plugin_id(id) {
                return Err(bad("invalid plugin id"));
            }
        }
    }
    if op == "plugin.enable" && p.get("grant").is_some_and(|v| !v.is_boolean()) {
        return Err(bad("grant: Invalid input: expected boolean"));
    }
    if [
        "plugin.ui.render",
        "plugin.ui.action",
        "plugin.ui.visibility",
    ]
    .contains(&op)
    {
        let surface = string(p, "surface")?;
        if !["activity", "panelTab", "status"].contains(&surface)
            && !(op == "plugin.ui.visibility" && surface == "settings")
        {
            return Err(bad("surface: Invalid option"));
        }
        let id = string(p, "id")?;
        if id.is_empty()
            || id.len() > 32
            || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(bad("id: Invalid string"));
        }
    }
    if ["plugin.ui.render", "plugin.ui.action"].contains(&op) {
        let c = &p["context"];
        if !c.is_object()
            || !c["route"].as_str().is_some_and(|s| ui::ROUTES.contains(&s))
            || !c["theme"]
                .as_str()
                .is_some_and(|s| ["light", "dark"].contains(&s))
        {
            return Err(bad("context: Invalid input"));
        }
        if c.get("taskId").is_some_and(|v| {
            !v.as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            })
        }) {
            return Err(bad("context.taskId: Invalid string"));
        }
    }
    if op == "plugin.ui.action" {
        let a = string(p, "action")?;
        if a.is_empty()
            || a.len() > 64
            || !a
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(bad("action: Invalid string"));
        }
        let r = string(p, "requestId")?;
        if r.is_empty() || crate::js_semantics::codepoint_len(r) > 128 {
            return Err(bad("requestId: Invalid string"));
        }
        if let Some(v) = p.get("values")
            && !v.as_object().is_some_and(|v| {
                v.len() <= 20
                    && v.iter().all(|(k, v)| {
                        crate::js_semantics::codepoint_len(k) <= 64
                            && !crate::json::nonfinite(v)
                            && (v.is_null()
                                || v.is_number()
                                || v.is_boolean()
                                || v.as_str()
                                    .is_some_and(|s| crate::js_semantics::codepoint_len(s) <= 2000))
                    })
            })
        {
            return Err(bad("values: Invalid input"));
        }
    }
    if op == "plugin.settings.set" && !p["values"].is_object() {
        return Err(bad("values: Invalid input: expected record"));
    }
    if ["plugin.settings.set", "plugin.ui.visibility"].contains(&op)
        && !p["expect_rev"].as_f64().is_some_and(|n| {
            n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0
        })
    {
        return Err(bad(
            "expect_rev: Invalid input: expected nonnegative safe integer",
        ));
    }
    if op == "plugin.ui.visibility" && !p["visible"].is_boolean() {
        return Err(bad("visible: Invalid input: expected boolean"));
    }
    Ok(())
}
impl MutationOperations {
    fn ui(&self) -> std::sync::MutexGuard<'_, HashMap<String, UiState>> {
        self.ui
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub fn invalidate(&self, id: &str, surface: Option<&str>) {
        if let Some(s) = self.ui().get_mut(id) {
            s.cache
                .retain(|(key, _)| surface.is_some_and(|id| !key.starts_with(&format!("{id}\0"))));
        }
    }
    pub async fn call(
        &self,
        ctx: &Ctx,
        runtime: &mut dyn MutationRuntime,
        op: &str,
        p: Value,
    ) -> Result<Value, CoreError> {
        if !MUTATION_OPERATIONS.contains(&op) {
            return Err(CoreError::new(
                Code::UnknownOp,
                format!("unknown operation \"{op}\""),
            ));
        }
        let mut p = if p.is_null() { json!({}) } else { p };
        params(op, &p)?;
        let fields: &[&str] = match op {
            "plugin.install" => &[],
            "plugin.enable" => &["id", "grant"],
            "plugin.disable" | "plugin.remove" => &["id"],
            "plugin.ui.render" => &["plugin", "surface", "id", "context"],
            "plugin.ui.action" => &[
                "plugin",
                "surface",
                "id",
                "action",
                "context",
                "requestId",
                "values",
            ],
            "plugin.ui.visibility" => &["plugin", "surface", "id", "visible", "expect_rev"],
            _ => &["plugin", "values", "expect_rev"],
        };
        if let Some(o) = p.as_object_mut() {
            o.retain(|k, _| fields.contains(&k.as_str()));
        }
        if let Some(o) = p.get_mut("context").and_then(Value::as_object_mut) {
            o.retain(|k, _| ["route", "taskId", "theme"].contains(&k.as_str()));
        }
        if op == "plugin.install" {
            return Err(CoreError::new(
                Code::NotAllowed,
                "pacer no longer ships an Orca plugin",
            )
            .hint("Use the pacer desktop app or pacer open. Remove an earlier install with: pacer plugin uninstall"));
        }
        let mut entries = runtime.refresh(ctx)?;
        let collator = icu_collator::CollatorBorrowed::new_root(Default::default());
        entries.sort_by(|a, b| collator.compare(&a.id, &b.id));
        let id = if op.starts_with("plugin.ui.") || op.starts_with("plugin.settings.") {
            string(&p, "plugin")?
        } else {
            string(&p, "id")?
        };
        let e = find(&entries, id)?;
        match op {
            "plugin.enable" => {
                if e.state == "refused" {
                    return Err(CoreError::new(
                        Code::PluginRefused,
                        format!(
                            "plugin {id} cannot be enabled: {}",
                            e.error.as_deref().unwrap_or("null")
                        ),
                    ));
                }
                let cfg = read_config(ctx)?;
                let current = &cfg["installed"][id];
                let m = e.manifest();
                let needs = m["capabilities"]
                    .as_array()
                    .map(|a| a.iter().map(|c| c["name"].clone()).collect::<Vec<_>>())
                    .unwrap_or_default();
                let surfaces = e.kinds();
                let covered = e.bundled
                    || (!current.is_null()
                        && needs.iter().all(|n| {
                            current["capabilities"]
                                .as_array()
                                .is_some_and(|a| a.contains(n))
                        })
                        && surfaces.iter().all(|k| {
                            current["surfaces"]
                                .as_array()
                                .is_some_and(|a| a.contains(&json!(k)))
                        }));
                if !covered && p["grant"] != true {
                    let mut out = json!({"id":id,"state":"needs_grant","needs":needs});
                    if !surfaces.is_empty() {
                        out["surfaces"] = json!(surfaces);
                    }
                    return Ok(out);
                }
                let policy = m["contributes"].get("policy").is_some();
                if !e.bundled
                    && (!covered
                        || current["version"] != m["version"]
                        || current["policy"] != policy)
                {
                    let mut grant = json!({"version":m["version"],"capabilities":needs});
                    if !surfaces.is_empty() {
                        grant["surfaces"] = json!(surfaces);
                    }
                    grant["policy"] = json!(policy);
                    edit_config(ctx, id, None, Some(Some(grant)))?;
                }
                edit_config(ctx, id, Some(false), None)?;
                runtime.reset(id);
                runtime.changed(ctx, id, false).await?;
                let e = find(&runtime.refresh(ctx)?, id)?;
                Ok(json!({"id":id,"state":e.state}))
            }
            "plugin.disable" => {
                if e.state == "refused" {
                    return Err(CoreError::new(
                        Code::PluginRefused,
                        format!(
                            "plugin {id} is refused: {}",
                            e.error.as_deref().unwrap_or("null")
                        ),
                    ));
                }
                edit_config(ctx, id, Some(true), None)?;
                runtime.stop(ctx, id).await?;
                self.invalidate(id, None);
                runtime.changed(ctx, id, false).await?;
                Ok(json!({"id":id,"state":find(&runtime.refresh(ctx)?,id)?.state}))
            }
            "plugin.remove" => {
                if e.bundled {
                    return Err(CoreError::new(
                        Code::NotAllowed,
                        format!("plugin {id} is bundled with pacer and cannot be removed"),
                    )
                    .hint("Use plugin.disable instead."));
                }
                runtime.stop(ctx, id).await?;
                let root = std::fs::canonicalize(ctx.pacer_home.join("plugins"))
                    .map_err(crate::private::error)?;
                crate::private::parents(&root)?;
                let dir = root.join(id);
                match std::fs::symlink_metadata(&dir) {
                    Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {
                        std::fs::remove_dir_all(&dir).map_err(crate::private::error)?
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => (),
                    _ => {
                        return Err(CoreError::new(
                            Code::PluginRefused,
                            "redirected plugin directory",
                        ));
                    }
                }
                edit_config(ctx, id, None, Some(None))?;
                edit_config(ctx, id, Some(false), None)?;
                settings::forget(ctx, id)?;
                self.ui().remove(id);
                runtime.changed(ctx, id, false).await?;
                Ok(json!({"id":id,"removed":true}))
            }
            "plugin.settings.set" => {
                let page = page(&e)?;
                let mut errors = settings::validate(&page["schema"], &p["values"]);
                if errors.is_empty() && e.state == "ready" {
                    let out = runtime
                        .call(
                            ctx,
                            id,
                            "ui.settings.validate",
                            json!({"id":page["id"],"values":p["values"]}),
                        )
                        .await?;
                    errors = ui::validate_result(out).map_err(|_| {
                        CoreError::new(
                            Code::InvalidInput,
                            format!("plugin {id} returned an invalid ui.settings.validate result"),
                        )
                    })?;
                }
                if !errors.is_empty() {
                    return Err(settings_error(id, errors));
                }
                let rec = settings::save(
                    ctx,
                    id,
                    p["values"].clone(),
                    p["expect_rev"].as_f64().unwrap_or(0.0),
                )?;
                self.invalidate(id, None);
                runtime.changed(ctx, id, true).await?;
                Ok(json!({"values":rec["values"],"rev":rec["rev"]}))
            }
            "plugin.ui.visibility" => {
                let surface = string(&p, "surface")?;
                let sid = string(&p, "id")?;
                e.surface(surface, sid)?;
                let rec = settings::visibility(
                    ctx,
                    id,
                    &format!("{}:{sid}", kind(surface)),
                    p["visible"] == true,
                    p["expect_rev"].as_f64().unwrap_or(0.0),
                )?;
                runtime.changed(ctx, id, false).await?;
                Ok(
                    json!({"plugin":id,"surface":surface,"id":sid,"visible":p["visible"],"rev":rec["rev"]}),
                )
            }
            "plugin.ui.render" => self.render(ctx, runtime, e, &p).await,
            "plugin.ui.action" => self.action(ctx, runtime, e, &p).await,
            _ => Err(CoreError::new(Code::UnknownOp, "unknown plugin operation")),
        }
    }
    async fn render(
        &self,
        ctx: &Ctx,
        runtime: &mut dyn MutationRuntime,
        e: Entry,
        p: &Value,
    ) -> Result<Value, CoreError> {
        let id = &e.id;
        let surface = string(p, "surface")?;
        let sid = string(p, "id")?;
        let def = e.surface(surface, sid)?;
        if !e.available() {
            return Err(e.unavailable());
        }
        let c = &p["context"];
        let key = format!(
            "{sid}\0{}\0{}\0{}",
            c["route"].as_str().unwrap_or(""),
            c["taskId"].as_str().unwrap_or(""),
            c["theme"].as_str().unwrap_or("")
        );
        let at = now();
        let response = |v: &Cached, stale| json!({"document":v.document,"renderedAt":v.at,"ttlS":v.ttl,"stale":stale});
        let hit = {
            let mut ui = self.ui();
            let state = ui.entry(id.clone()).or_default();
            let hit = state
                .cache
                .iter()
                .find(|(k, _)| k == &key)
                .map(|(_, v)| v.clone());
            if let Some(h) = &hit
                && at - h.at < h.ttl * 1000.0
            {
                return Ok(response(h, false));
            }
            if surface == "status" && e.state != "ready" {
                return Err(CoreError::new(
                    Code::PluginUnavailable,
                    format!("plugin {id} is not running"),
                ));
            }
            let recent = state.renders.entry(sid.into()).or_default();
            recent.retain(|t| at - t < 1000.0);
            if recent.len() >= 2 {
                return Err(CoreError::new(
                    Code::Conflict,
                    format!("surface {sid} is rendering too often"),
                )
                .hint("Retry in a second."));
            }
            recent.push(at);
            hit
        };
        let raw = runtime
            .call(
                ctx,
                id,
                "ui.render",
                json!({"surface":surface,"id":sid,"view":def["view"],"context":c}),
            )
            .await;
        let result = match raw {
            Ok(raw) => {
                if raw.get("ttlS").is_some_and(|v| {
                    !v.as_f64()
                        .is_some_and(|n| n.fract() == 0.0 && (0.0..=3600.0).contains(&n))
                }) {
                    Err(CoreError::new(
                        Code::InvalidInput,
                        format!("plugin {id} returned an invalid ui.render result"),
                    ))
                } else {
                    match ui::parse(raw["document"].clone(), surface == "status") {
                        Ok(document) => {
                            let ttl = raw["ttlS"]
                                .as_f64()
                                .unwrap_or(60.0)
                                .clamp(if surface == "status" { 30.0 } else { 0.0 }, 3600.0);
                            let mut ui = self.ui();
                            let state = ui.entry(id.clone()).or_default();
                            state.cache.retain(|(_, v)| at - v.at < v.ttl * 10000.0);
                            while state.cache.len() >= 64 {
                                state.cache.pop_front();
                            }
                            let cached = Cached { document, at, ttl };
                            state.cache.retain(|(k, _)| k != &key);
                            state.cache.push_back((key, cached.clone()));
                            Ok(response(&cached, false))
                        }
                        Err(error) => {
                            let mut ui = self.ui();
                            let state = ui.entry(id.clone()).or_default();
                            if at - state.invalid_logs.get(sid).copied().unwrap_or(0.0) >= 60000.0 {
                                state.invalid_logs.insert(sid.into(), at);
                                runtime.log(
                                    ctx,
                                    id,
                                    &format!("invalid ui.render document for {sid}: {error}"),
                                );
                            }
                            Err(CoreError::new(
                                Code::InvalidInput,
                                "This plugin's view couldn't be shown",
                            ))
                        }
                    }
                }
            }
            Err(e) => Err(e),
        };
        match result {
            Err(err) if err.code != Code::InvalidInput => {
                let refreshed = runtime.refresh(ctx)?;
                let current = find(&refreshed, id)?;
                if let Some(hit) = hit
                    && current.available()
                    && at - hit.at < hit.ttl.max(30.0) * 10000.0
                {
                    return Ok(response(&hit, true));
                }
                Err(err)
            }
            other => other,
        }
    }
    async fn action(
        &self,
        ctx: &Ctx,
        runtime: &mut dyn MutationRuntime,
        e: Entry,
        p: &Value,
    ) -> Result<Value, CoreError> {
        let id = &e.id;
        let surface = string(p, "surface")?;
        let sid = string(p, "id")?;
        e.surface(surface, sid)?;
        let at = now();
        let _inflight = {
            let mut ui = self.ui();
            let state = ui.entry(id.clone()).or_default();
            state.actions.retain(|t| at - t < 60000.0);
            if state.actions.len() >= 10 {
                return Err(CoreError::new(
                    Code::Conflict,
                    format!("plugin {id} has had too many actions"),
                )
                .hint("Retry in a minute."));
            }
            {
                let mut inflight = state.inflight.lock().map_err(|_| {
                    CoreError::new(Code::Internal, "plugin action state unavailable")
                })?;
                if inflight.contains(sid) {
                    return Err(CoreError::new(
                        Code::Conflict,
                        format!("surface {sid} already has an action in flight"),
                    )
                    .hint("Retry shortly."));
                }
                state.actions.push(at);
                inflight.insert(sid.into());
            }
            InFlight {
                set: Arc::clone(&state.inflight),
                id: sid.into(),
            }
        };
        let mut input = p.clone();
        if let Some(o) = input.as_object_mut() {
            o.remove("plugin");
        }
        let out = runtime.call(ctx, id, "ui.action", input).await;
        let mut out = out?;
        if !out["result"]
            .as_str()
            .is_some_and(|s| ["done", "refresh"].contains(&s))
            || out.get("message").is_some_and(|s| {
                !s.as_str().is_some_and(|s| {
                    crate::js_semantics::codepoint_len(&settings::clean_text(s)) <= 200
                })
            })
        {
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("plugin {id} returned an invalid ui.action result"),
            ));
        }
        if out["result"] == "refresh" {
            self.invalidate(id, Some(sid));
        }
        if let Some(s) = out["message"].as_str() {
            out["message"] = json!(settings::clean_text(s));
        }
        if let Some(o) = out.as_object_mut() {
            o.retain(|k, _| ["result", "message"].contains(&k.as_str()));
        }
        Ok(out)
    }
}
