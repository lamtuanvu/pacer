//! Public plugin operations, parameterized by the single process owner.
//!
//! P4c does not acquire process ownership: the service activates these handlers
//! only when its runtime can provide authoritative snapshots and diagnostic RPC.
//! Standalone TypeScript remains the fallback until that cutover.
#![allow(clippy::result_large_err)]
use crate::settings;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};
/// Only read operations are eligible for native dispatch during this cutover.
pub const OPERATIONS: &[&str] = &[
    "plugin.list",
    "plugin.doctor",
    "plugin.ui.list",
    "plugin.settings.get",
];
const KINDS: &[&str] = &["activity", "panelTabs", "settings", "status"];
const ENABLED: &[&str] = &["idle", "starting", "ready"];
/// Snapshot supplied by the process owner, never by a public request.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Entry {
    pub id: String,
    pub manifest: Option<Value>,
    pub bundled: bool,
    pub grant: Value,
    pub state: String,
    pub error: Option<String>,
    pub pid: Option<u32>,
    pub served: Vec<String>,
    pub protocol: Option<String>,
    pub restarts: usize,
}
impl Entry {
    pub(crate) fn manifest(&self) -> &Value {
        self.manifest.as_ref().unwrap_or(&Value::Null)
    }
    pub(crate) fn surfaces(&self, kind: &str) -> &[Value] {
        self.manifest()["contributes"]["ui"][kind]
            .as_array()
            .map_or(&[], Vec::as_slice)
    }
    pub(crate) fn kinds(&self) -> Vec<&str> {
        KINDS
            .iter()
            .copied()
            .filter(|k| !self.surfaces(k).is_empty())
            .collect()
    }
    pub(crate) fn available(&self) -> bool {
        ENABLED.contains(&self.state.as_str())
    }
    pub fn surface(&self, surface: &str, id: &str) -> Result<&Value, CoreError> {
        let kind = if surface == "panelTab" {
            "panelTabs"
        } else {
            surface
        };
        self.surfaces(kind)
            .iter()
            .find(|s| s["id"] == id)
            .ok_or_else(|| {
                CoreError::new(
                    Code::NotFound,
                    format!("plugin {} has no {surface} surface {id}", self.id),
                )
            })
    }
    pub(crate) fn unavailable(&self) -> CoreError {
        CoreError::new(
            Code::PluginUnavailable,
            format!(
                "plugin {} is {}{}",
                self.id,
                self.state,
                self.error
                    .as_ref()
                    .map_or(String::new(), |e| format!(": {e}"))
            ),
        )
    }
}
/// All runtime effects belong to one host. No second process registry is created.
pub trait Runtime: Send {
    fn refresh(&mut self, ctx: &Ctx) -> Result<Vec<Entry>, CoreError>;
    fn call<'a>(
        &'a mut self,
        ctx: &'a Ctx,
        id: &'a str,
        method: &'a str,
        params: Value,
    ) -> OpFuture<'a>;
}
#[derive(Default)]
pub struct PublicOperations {}
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
fn string<'a>(p: &'a Value, name: &str) -> Result<&'a str, CoreError> {
    p[name].as_str().ok_or_else(|| {
        CoreError::new(
            Code::InvalidInput,
            format!("{name}: Invalid input: expected string"),
        )
    })
}
fn valid_plugin_id(id: &str) -> bool {
    id.len() >= 2
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
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
    if !["plugin.list", "plugin.ui.list"].contains(&op) {
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
    Ok(())
}
impl PublicOperations {
    pub async fn call(
        &self,
        ctx: &Ctx,
        runtime: &mut dyn Runtime,
        op: &str,
        p: Value,
    ) -> Result<Value, CoreError> {
        if !OPERATIONS.contains(&op) {
            return Err(CoreError::new(
                Code::UnknownOp,
                format!("unknown operation \"{op}\""),
            ));
        }
        // callOp treats an explicit null exactly like omitted parameters.
        let mut p = if p.is_null() { json!({}) } else { p };
        params(op, &p)?;
        let fields: &[&str] = match op {
            "plugin.list" | "plugin.ui.list" => &[],
            "plugin.doctor" => &["id"],
            _ => &["plugin"],
        };
        if let Some(o) = p.as_object_mut() {
            o.retain(|k, _| fields.contains(&k.as_str()));
        }
        if let Some(o) = p.get_mut("context").and_then(Value::as_object_mut) {
            o.retain(|k, _| ["route", "taskId", "theme"].contains(&k.as_str()));
        }
        let mut entries = runtime.refresh(ctx)?;
        let collator = icu_collator::CollatorBorrowed::new_root(Default::default());
        entries.sort_by(|a, b| collator.compare(&a.id, &b.id));
        if op == "plugin.list" {
            return Ok(
                json!({"plugins":entries.iter().map(|e|{let m=e.manifest();let ui=KINDS.iter().map(|k|(k.to_string(),json!(e.surfaces(k).len()))).collect::<serde_json::Map<_,_>>();json!({"ui":ui,"surfaces":e.kinds(),"id":e.id,"version":m["version"].as_str().unwrap_or(""),"publisher":m["publisher"].as_str().unwrap_or(""),"tier":m["tier"].as_str().unwrap_or("free"),"bundled":e.bundled,"enabled":e.available() || e.state=="failing","state":e.state,"contributes":m["contributes"].as_object().map(|o|o.keys().collect::<Vec<_>>()).unwrap_or_default(),"capabilities":m["capabilities"].as_array().cloned().unwrap_or_default(),"grant":e.grant,"error":e.error,"pid":e.pid})}).collect::<Vec<_>>()}),
            );
        }
        if op == "plugin.ui.list" {
            let mut surfaces = vec![];
            for e in entries.iter().filter(|e| {
                (e.available() || e.state == "failing")
                    && e.manifest()["contributes"]["ui"].is_object()
            }) {
                let record = settings::read(ctx, &e.id)?;
                for k in KINDS {
                    for s in e.surfaces(k) {
                        surfaces.push(json!({"plugin":e.id,"surface":k,"id":s["id"],"title":s["title"],"icon":s.get("icon").unwrap_or(&Value::Null),"context":s["context"].as_str().unwrap_or("global"),"visible":!record["hidden"].as_array().is_some_and(|a|a.contains(&json!(format!("{k}:{}",s["id"].as_str().unwrap_or(""))))),"state":e.state}));
                    }
                }
            }
            return Ok(json!({"surfaces":surfaces}));
        }
        if op == "plugin.doctor" {
            let targets = if let Some(id) = p["id"].as_str() {
                vec![find(&entries, id)?]
            } else {
                entries
            };
            let mut reports = vec![];
            for mut e in targets {
                let mut ok = false;
                let mut error = e.error.clone();
                if e.available() {
                    match runtime.call(ctx, &e.id, "diagnostic.ping", json!({})).await {
                        Ok(_) => {
                            ok = true;
                            error = None;
                        }
                        Err(err) => {
                            error = Some(format!(
                                "{}: {}",
                                serde_json::to_value(err.code)
                                    .unwrap_or(Value::Null)
                                    .as_str()
                                    .unwrap_or("internal"),
                                err.message
                            ));
                        }
                    }
                    let refreshed = runtime.refresh(ctx)?;
                    if let Ok(next) = find(&refreshed, &e.id) {
                        e = next;
                    }
                }
                // TypeScript's key order: `{...base, ok, state, pid, restarts, error}`.
                reports.push(json!({"id":e.id,"served":e.served,"protocol":{"host":pacer_plugin_protocol::VERSION,"plugin":e.protocol},"needs":e.manifest()["host"],"ok":ok,"state":e.state,"pid":e.pid,"restarts":e.restarts,"error":error}));
            }
            return Ok(json!({"reports":reports}));
        }
        let id = if op.starts_with("plugin.ui.") || op.starts_with("plugin.settings.") {
            string(&p, "plugin")?
        } else {
            string(&p, "id")?
        };
        let e = find(&entries, id)?;
        match op {
            "plugin.settings.get" => {
                let page = page(&e)?;
                let rec = settings::read(ctx, id)?;
                Ok(
                    json!({"id":page["id"],"title":page["title"],"schema":page["schema"],"values":rec["values"],"rev":rec["rev"]}),
                )
            }
            _ => Err(CoreError::new(Code::UnknownOp, "unknown plugin operation")),
        }
    }
}

/// Registry selection is explicit. An absent process owner means forward to TS,
/// never instantiate an independent host from a public operation.
#[derive(Default)]
pub struct PublicRegistry {
    operations: PublicOperations,
    runtime: Option<Box<dyn Runtime>>,
}
impl PublicRegistry {
    pub fn with_runtime(runtime: Box<dyn Runtime>) -> Self {
        Self {
            operations: PublicOperations::default(),
            runtime: Some(runtime),
        }
    }
    pub fn native_names(&self) -> Vec<&'static str> {
        if self.runtime.is_some() {
            OPERATIONS.to_vec()
        } else {
            vec![]
        }
    }
    pub async fn dispatch(
        &mut self,
        ctx: &Ctx,
        op: &str,
        params: Value,
    ) -> Option<Result<Value, CoreError>> {
        if !OPERATIONS.contains(&op) {
            return None;
        }
        let runtime = self.runtime.as_mut()?;
        Some(
            self.operations
                .call(ctx, runtime.as_mut(), op, params)
                .await,
        )
    }
}
