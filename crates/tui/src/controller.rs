//! The dashboard controller, ported from `src/dashboard/controller.ts` and
//! `src/dashboard/data.ts`. It holds state, reads through a [`DashClient`],
//! runs effects and draws frames. Effects are described by [`state::Effect`];
//! the embedding CLI supplies the concrete client (B11-2).

#[cfg(test)]
mod tests;

use crate::render_frame;
use crate::state::{self, Action, Effect, KeyContext, KeyResult, ManagedStep, UiState};
use crate::theme::{Appearance, ColorDepth, TerminalTheme};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// A transport error from the dashboard client.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DashError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
}

impl DashError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }
    /// A transport failure (connection refused, fetch failed) that a fallback
    /// can act on, as opposed to an API error which must be preserved.
    pub fn transport(message: impl Into<String>) -> Self {
        Self::new("transport", message)
    }
    pub fn is_transport(&self) -> bool {
        self.code == "transport"
    }
}

/// The read/write surface the controller needs from a service client (ARCH-1).
pub trait DashClient: Send + Sync {
    fn call(&self, op: &str, params: Value) -> Result<Value, DashError>;
    fn snapshot(&self) -> Result<Value, DashError>;
    fn supports(&self, op: &str) -> bool;
    /// Hello's `ops` list, cached after the first refresh.
    fn hello(&self) -> Result<Value, DashError>;
    /// `"http"` or `"inprocess"`.
    fn kind(&self) -> &'static str;
}

/// A fetched resource: the last value stays visible while a refresh runs.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Resource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ResourceError>,
    #[serde(default)]
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_stamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ResourceError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DashData {
    #[serde(default)]
    pub details: BTreeMap<String, Resource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Resource>,
    #[serde(default)]
    pub settings: BTreeMap<String, Resource>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Message {
    pub text: String,
    pub tone: String,
}

/// Fixed start-up inputs. Values (not closures) keep the library easy to drive
/// from goldens and from the CLI's one-shot/interactive loops (B11-2).
#[derive(Clone, Debug)]
pub struct DashboardDeps {
    pub theme: TerminalTheme,
    pub version: String,
    pub cwd: String,
    pub now: f64,
    pub width: u16,
    pub height: u16,
    pub time_zone: Option<String>,
    /// The footer's cached update reading (`"current"`, `"available"`, ...).
    pub update: Option<String>,
}

impl Default for DashboardDeps {
    fn default() -> Self {
        Self {
            theme: crate::theme::PLAIN_THEME,
            version: "0.0.0-test".to_string(),
            cwd: "/tmp/repo".to_string(),
            now: 1_800_000_000.0,
            width: 120,
            height: 40,
            time_zone: Some("UTC".to_string()),
            update: None,
        }
    }
}

/// A terminal-level result a key can produce. Matches the brief's interface
/// exactly: `Quit`, `Attach`, or `Handoff`. The embedding CLI performs the
/// attach/hand-off (B11-2); the library only describes it. Non-terminal
/// effects run their side effects and yield no outcome.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Quit,
    Attach { id: String, target: String },
    Handoff { argv: Vec<String>, label: String },
}

const SPINNER: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SETTINGS_OPS: &[(&str, &str)] = &[
    ("config", "config.get"),
    ("accounts", "account.list"),
    ("routing", "routing.get"),
    ("projects", "project.strategy.list"),
    ("strategies", "strategy.list"),
    ("update", "update.check"),
    ("notifications", "notifications.get"),
];

const SETTINGS_MUTATIONS: &[&str] = &[
    "config.set",
    "runner.",
    "account.",
    "routing.set",
    "project.strategy.set",
    "project.strategy.remove",
    "strategy.use",
    "strategy.save",
    "strategy.remove",
    "notifications.set",
    "update.",
    "host.set",
];

/// The dashboard controller.
pub struct Dashboard<C: DashClient> {
    pub client: C,
    pub state: UiState,
    pub data: DashData,
    pub snapshot: Value,
    pub ops: Option<Vec<String>>,
    pub connection: String,
    pub theme: TerminalTheme,
    pub deps: DashboardDeps,
    /// The key context for `key()`; the embedding client refreshes it from the
    /// visible screen items (B11-2). Empty by default.
    pub key_ctx: KeyContext,
    pub frames: Vec<String>,
    pub calls: Vec<(String, Value)>,
    message: Option<Message>,
    message_until: f64,
    message_until_read: bool,
    read_at: Option<f64>,
    frame: u64,
    loading: usize,
    settings_loaded: std::collections::BTreeSet<String>,
}

impl<C: DashClient> Dashboard<C> {
    pub fn new(client: C, deps: DashboardDeps) -> Self {
        Self {
            client,
            state: state::initial_state(),
            data: DashData::default(),
            snapshot: Value::Null,
            ops: None,
            connection: "connecting".to_string(),
            theme: deps.theme.clone(),
            deps,
            key_ctx: KeyContext {
                page: 38,
                ..KeyContext::default()
            },
            frames: Vec::new(),
            calls: Vec::new(),
            message: None,
            message_until: 0.0,
            message_until_read: false,
            read_at: None,
            frame: 0,
            loading: 0,
            settings_loaded: std::collections::BTreeSet::new(),
        }
    }

    pub fn supports(&self, op: &str) -> bool {
        match &self.ops {
            None => true,
            Some(ops) => ops.iter().any(|o| o == op),
        }
    }

    /// Resolve once every started read has finished. For the synchronous
    /// library port all reads are immediate, so this is a no-op hook.
    pub fn settle(&self) {}

    pub fn report(&mut self, text: &str, tone: &str) {
        let line = text
            .split(['\r', '\n'])
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        self.message = Some(Message {
            text: line,
            tone: tone.to_string(),
        });
        self.message_until = self.deps.now + 5.0;
        self.message_until_read = false;
        self.draw();
    }

    /// The service stopped answering and reads moved to a local client.
    pub fn fallback(&mut self) {
        self.message = Some(Message {
            text: "pacer serve unavailable; working locally".to_string(),
            tone: "warn".to_string(),
        });
        self.message_until = f64::INFINITY;
        self.message_until_read = true;
        self.draw();
    }

    pub fn report_error(&mut self, error: &DashError) {
        let text = match &error.hint {
            Some(hint) => format!("{} ({hint})", error.message),
            None => error.message.clone(),
        };
        self.report(&text, "bad");
    }

    /// Build the frame input (the TS `Dashboard.input()` shape) and render it.
    pub fn frame_input(&self) -> Value {
        let mut input = Map::new();
        input.insert("snapshot".to_string(), self.snapshot.clone());
        input.insert(
            "state".to_string(),
            serde_json::to_value(&self.state).unwrap_or(Value::Null),
        );
        input.insert("now".to_string(), serde_json::json!(self.deps.now));
        input.insert("width".to_string(), serde_json::json!(self.deps.width));
        input.insert("height".to_string(), serde_json::json!(self.deps.height));
        input.insert(
            "details".to_string(),
            serde_json::to_value(&self.data.details).unwrap_or(Value::Null),
        );
        input.insert(
            "settings".to_string(),
            serde_json::to_value(&self.data.settings).unwrap_or(Value::Null),
        );
        input.insert(
            "version".to_string(),
            Value::String(self.deps.version.clone()),
        );
        input.insert(
            "connection".to_string(),
            Value::String(self.connection.clone()),
        );
        input.insert(
            "ops".to_string(),
            match &self.ops {
                Some(ops) => serde_json::to_value(ops).unwrap_or(Value::Null),
                None => Value::Null,
            },
        );
        if let Some(read_at) = self.read_at {
            input.insert("readAt".to_string(), serde_json::json!(read_at));
        }
        if let Some(tz) = &self.deps.time_zone {
            input.insert("timeZone".to_string(), Value::String(tz.clone()));
        }
        if let Some(u) = &self.deps.update {
            input.insert("update".to_string(), Value::String(u.clone()));
        }
        if self.theme.motion && self.loading > 0 {
            input.insert(
                "spinner".to_string(),
                Value::String(SPINNER[self.frame as usize % SPINNER.len()].to_string()),
            );
        }
        if let Some(message) = &self.message
            && self.message_until > self.deps.now
        {
            input.insert(
                "message".to_string(),
                serde_json::to_value(message).unwrap_or(Value::Null),
            );
        }
        Value::Object(input)
    }

    pub fn render(&self) -> String {
        let input = self.frame_input();
        render_frame(&input, &input).unwrap_or_else(|e| {
            format!("pacer dashboard could not draw this screen: {e}\nPress 1 for Home, R to refresh or q to quit.")
        })
    }

    /// A rendering bug must not take the terminal down: show it, keep keys working.
    pub fn draw(&mut self) {
        let frame = self.render();
        self.frames.push(frame);
    }

    pub fn tick(&mut self) {
        self.frame += 1;
        if self.loading > 0 && self.theme.motion {
            self.draw();
        }
    }

    /// Read hello and the snapshot.
    pub fn refresh(&mut self) -> Result<(), DashError> {
        let result = match self.client.snapshot() {
            Ok(v) => v,
            Err(e) => {
                if self.read_at.is_some() {
                    self.connection = "offline".to_string();
                    self.draw();
                }
                self.report_error(&e);
                return Err(e);
            }
        };
        let hello = match self.hello() {
            Ok(v) => v,
            Err(e) => {
                self.report_error(&e);
                return Err(e);
            }
        };
        if let Some(ops) = hello.get("ops").and_then(Value::as_array) {
            self.ops = Some(
                ops.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
            );
        }
        self.snapshot = result.get("snapshot").cloned().unwrap_or(result.clone());
        self.connection = if self.client.kind() == "http" {
            "live"
        } else {
            "local"
        }
        .to_string();
        self.read_at = Some(self.deps.now);
        if self.message_until_read {
            self.message_until = self.read_at.unwrap_or(self.deps.now) + 5.0;
            self.message_until_read = false;
        }
        self.load_needs();
        self.draw();
        Ok(())
    }

    fn hello(&self) -> Result<Value, DashError> {
        match &self.ops {
            Some(ops) => Ok(serde_json::json!({ "ops": ops })),
            None => self.client.hello(),
        }
    }

    /// Fetch the settings resources the visible Settings section needs.
    pub fn load_needs(&mut self) {
        if self.state.screen != "settings" {
            return;
        }
        let section = self.state.section.clone();
        if self.settings_loaded.contains(&section) {
            return;
        }
        let Some((_, op)) = SETTINGS_OPS.iter().find(|(key, _)| *key == section) else {
            return;
        };
        if !self.supports(op) {
            return;
        }
        self.settings_loaded.insert(section.clone());
        let params = Map::new();
        let result = self
            .client
            .call(op, Value::Object(params.clone()))
            .map_err(|e| error_resource(&e));
        match result {
            Ok(value) => {
                self.data.settings.insert(
                    section,
                    Resource {
                        value: Some(value),
                        ..Resource::default()
                    },
                );
            }
            Err(error) => {
                self.data.settings.insert(
                    section,
                    Resource {
                        error: Some(error),
                        ..Resource::default()
                    },
                );
            }
        }
        self.draw();
    }

    /// Explicitly load one task detail (the controller normally does this in
    /// `loadNeeds`; exposing it keeps the library usable without the screen
    /// view port, which lands with B11-2's client).
    pub fn load_detail(&mut self, id: &str) -> Result<(), DashError> {
        let value = self
            .client
            .call("task.get", serde_json::json!({ "id": id }))?;
        self.data.details.insert(
            id.to_string(),
            Resource {
                value: Some(value),
                ..Resource::default()
            },
        );
        self.draw();
        Ok(())
    }

    /// `history-more` reads the next page of task history.
    pub fn load_history(&mut self, before: Option<&str>) -> Result<(), DashError> {
        if self.data.history.as_ref().is_some_and(|h| h.loading) || !self.supports("task.list") {
            return Ok(());
        }
        let mut params = Map::new();
        params.insert("all".to_string(), Value::Bool(true));
        params.insert("limit".to_string(), serde_json::json!(20));
        if let Some(before) = before {
            params.insert("before".to_string(), Value::String(before.to_string()));
        }
        let result = self.client.call("task.list", Value::Object(params));
        match result {
            Ok(value) => {
                self.data.history = Some(Resource {
                    value: Some(value),
                    ..Resource::default()
                });
            }
            Err(e) => {
                self.data.history = Some(Resource {
                    error: Some(error_resource(&e)),
                    ..Resource::default()
                });
            }
        }
        self.draw();
        Ok(())
    }

    pub fn invalidate_settings(&mut self) {
        self.settings_loaded.clear();
    }

    /// A service event: config/reset re-read the config section, then refresh.
    pub fn event(&mut self, event: &Value) {
        if matches!(
            event.get("type").and_then(Value::as_str),
            Some("config") | Some("reset")
        ) {
            self.settings_loaded.remove("config");
        }
        let _ = self.refresh();
    }

    /// Handle one key, applying it through the state reducer.
    pub fn key(&mut self, key: &str) -> Option<Outcome> {
        // Controller-only global keys.
        if key == "n" && self.state.overlay.is_none() && self.supports("session.create") {
            let _ = self.flow("conversation-prepare", &Map::new());
            return None;
        }
        if key == "d" && self.state.overlay.is_none() && self.supports("task.delegate") {
            let _ = self.flow("delegate", &Map::new());
            return None;
        }
        let result: KeyResult = state::reduce_key(&self.state, key, &self.key_ctx);
        self.state = result.state;
        if result.quit {
            return Some(Outcome::Quit);
        }
        if result.refresh {
            self.invalidate_settings();
            self.data.details.clear();
            self.data.history = None;
            let _ = self.refresh();
            self.report("Refreshed", "good");
            return None;
        }
        self.load_needs();
        self.draw();
        result.effect.and_then(|e| self.run(e))
    }

    /// Run one effect and return a terminal-level outcome when it needs one
    /// (`Quit`, `Attach`, or `Handoff`). All other effects run their side
    /// effects and yield no outcome.
    pub fn run(&mut self, effect: Effect) -> Option<Outcome> {
        match effect {
            Effect::HistoryMore => {
                let before = self
                    .data
                    .history
                    .as_ref()
                    .and_then(|h| h.value.as_ref())
                    .and_then(|v| v.get("next"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let _ = self.load_history(before.as_deref());
                None
            }
            Effect::Navigate {
                screen,
                id,
                section,
            } => {
                self.navigate(&screen, id.as_deref(), section.as_deref());
                None
            }
            Effect::Local { label } => {
                self.report(&label, "info");
                None
            }
            Effect::Action { action, fallback } => {
                let _ = self.call(&action, fallback.as_deref());
                None
            }
            Effect::Attach { id, target } => Some(Outcome::Attach { id, target }),
            Effect::Handoff { argv, label } => Some(Outcome::Handoff { argv, label }),
            Effect::Flow { name, params } => {
                let _ = self.flow(&name, &params);
                None
            }
            Effect::Prompt { .. } | Effect::Choose { .. } | Effect::Refresh | Effect::Quit => None,
        }
    }

    fn navigate(&mut self, screen: &str, id: Option<&str>, section: Option<&str>) {
        let prefix = match screen {
            "review" => Some("review:"),
            "sessions" => Some("session:"),
            _ => None,
        };
        if let Some(id) = id {
            if screen != "settings" {
                self.state.selected.insert(
                    screen.to_string(),
                    format!("{}{}", prefix.unwrap_or(""), id),
                );
            } else {
                self.state
                    .selected
                    .insert("settings".to_string(), id.to_string());
            }
        }
        self.state.screen = screen.to_string();
        self.state.focus = if screen == "settings" && section.is_some() {
            "detail"
        } else {
            "list"
        }
        .to_string();
        self.state.scroll = 0;
        self.state.overlay = None;
        if let Some(section) = section {
            self.state.section = section.to_string();
        }
        self.load_needs();
        self.draw();
    }

    /// Call an action's operation. On a managed-work refusal, run the fallback
    /// steps in order (`withManagedFallback`).
    pub fn call(
        &mut self,
        action: &Action,
        fallback: Option<&[ManagedStep]>,
    ) -> Result<Value, DashError> {
        self.calls
            .push((action.op.clone(), Value::Object(action.params.clone())));
        let mut result = self
            .client
            .call(&action.op, Value::Object(action.params.clone()));
        if result.is_err()
            && fallback.is_some_and(|f| !f.is_empty())
            && let Some(steps) = fallback
        {
            // Managed fallback runs each step; the last result is surfaced.
            for step in steps {
                self.calls
                    .push((step.op.clone(), Value::Object(step.params.clone())));
                result = self
                    .client
                    .call(&step.op, Value::Object(step.params.clone()));
                if result.is_err() {
                    break;
                }
            }
        }
        match &result {
            Ok(value) => {
                let text = success_copy(action, value);
                let tone = if action.op == "config.set" && value.get("warning").is_some() {
                    "warn"
                } else {
                    "good"
                };
                self.report(&text, tone);
            }
            Err(e) => self.report_error(e),
        }
        if action.op.starts_with("task.review") {
            self.after_review();
        }
        if is_settings_mutation(&action.op) {
            self.invalidate_settings();
        }
        if let Some(id) = action.params.get("id").and_then(Value::as_str) {
            self.data.details.remove(id);
        }
        let _ = self.refresh();
        result
    }

    fn after_review(&mut self) {
        let verb = self
            .message
            .as_ref()
            .map(|m| m.text.clone())
            .unwrap_or_else(|| "Done".to_string());
        self.report(&format!("{verb} · review queue is clear"), "good");
    }

    fn flow(&mut self, name: &str, params: &Map<String, Value>) -> Result<(), DashError> {
        if name == "appearance" {
            let key = params.get("key").and_then(Value::as_str).unwrap_or("");
            self.theme = match key {
                "theme" => TerminalTheme {
                    appearance: if self.theme.appearance == Appearance::Dark {
                        Appearance::Light
                    } else {
                        Appearance::Dark
                    },
                    ..self.theme.clone()
                },
                "motion" => TerminalTheme {
                    motion: !self.theme.motion,
                    ..self.theme.clone()
                },
                "glyphs" => TerminalTheme {
                    unicode: !self.theme.unicode,
                    ..self.theme.clone()
                },
                "color" => TerminalTheme {
                    depth: match self.theme.depth {
                        ColorDepth::Truecolor => ColorDepth::D256,
                        ColorDepth::D256 => ColorDepth::D16,
                        ColorDepth::D16 => ColorDepth::None,
                        ColorDepth::None => ColorDepth::Truecolor,
                    },
                    ..self.theme.clone()
                },
                _ => self.theme.clone(),
            };
            self.report("Applied for this session.", "good");
        }
        Ok(())
    }
}

fn error_resource(e: &DashError) -> ResourceError {
    ResourceError {
        message: e.message.clone(),
        hint: e.hint.clone(),
        code: Some(e.code.clone()),
    }
}

fn is_settings_mutation(op: &str) -> bool {
    SETTINGS_MUTATIONS.iter().any(|m| op.starts_with(m))
}

fn job_kind_copy(kind: &str) -> String {
    match kind {
        "task.review" => "review".to_string(),
        "host.check" => "checks".to_string(),
        _ => kind.to_string(),
    }
}

/// Plain result copy for each op; unknown ops report their label.
pub fn success_copy(action: &Action, result: &Value) -> String {
    if let Some(job) = result.get("job") {
        let kind = job
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or(&action.op);
        return format!("{}: {} started", action.label, job_kind_copy(kind));
    }
    match action.op.as_str() {
        "task.delegate" => format!(
            "Delegated · {} queued",
            result.get("task_id").and_then(Value::as_str).unwrap_or("")
        ),
        "task.retry" => match result
            .get("retry")
            .and_then(|r| r.get("task_id"))
            .and_then(Value::as_str)
        {
            Some(id) => format!("Retry queued · {id}"),
            None => "Retry queued".to_string(),
        },
        "task.stop" => "Stopped".to_string(),
        "task.review" => action.label.clone(),
        "onboarding.try" => format!(
            "Started {} on {}. Review it when it finishes.",
            result.get("task_id").and_then(Value::as_str).unwrap_or(""),
            result.get("executor").and_then(Value::as_str).unwrap_or("")
        ),
        "config.set" => match result.get("undo").and_then(Value::as_str) {
            Some(undo) => format!("Saved. Undo: {undo}"),
            None => "Saved.".to_string(),
        },
        "strategy.build" | "account.signin" | "runner.add" => {
            if result.get("opened").and_then(Value::as_bool) == Some(true) {
                format!("{}: opened in a new terminal", action.label)
            } else if let Some(cmd) = result.get("command").and_then(Value::as_str) {
                format!("Run: {cmd}")
            } else {
                format!("{}: done", action.label)
            }
        }
        "task.dismiss" | "attention.dismiss" => "Dismissed".to_string(),
        _ => format!("{}: done", action.label),
    }
}

/// Wrap a primary client so transport failures switch to a locally-made client
/// once (`src/dashboard/data.ts`). API errors are preserved; reads retry on
/// the local client, operations switch without repeating.
pub struct FallbackClient<P, L, F>
where
    P: DashClient,
    L: DashClient,
    F: Fn() -> L + Send + Sync,
{
    inner: Arc<Mutex<FallbackInner<P, L, F>>>,
}

struct FallbackInner<P, L, F>
where
    P: DashClient,
    L: DashClient,
    F: Fn() -> L + Send + Sync,
{
    primary: Option<P>,
    local: Option<L>,
    make_local: F,
    switched: bool,
    seq: u64,
}

impl<P, L, F> FallbackClient<P, L, F>
where
    P: DashClient,
    L: DashClient,
    F: Fn() -> L + Send + Sync,
{
    pub fn new(primary: P, make_local: F) -> Self {
        Self {
            inner: Arc::new(Mutex::new(FallbackInner {
                primary: Some(primary),
                local: None,
                make_local,
                switched: false,
                seq: 0,
            })),
        }
    }

    pub fn switched(&self) -> bool {
        self.inner.lock().map(|i| i.switched).unwrap_or(false)
    }

    pub fn seq(&self) -> u64 {
        self.inner.lock().map(|i| i.seq).unwrap_or(0)
    }

    fn switch(&self) {
        if let Ok(mut inner) = self.inner.lock()
            && !inner.switched
        {
            inner.local = Some((inner.make_local)());
            if let Some(primary) = inner.primary.take() {
                drop(primary);
            }
            inner.switched = true;
        }
    }

    fn with_read<T>(
        &self,
        retry: bool,
        f: impl Fn(&dyn DashClient) -> Result<T, DashError>,
    ) -> Result<T, DashError> {
        let use_local = self.switched();
        let first = if use_local {
            let guard = self
                .inner
                .lock()
                .map_err(|_| DashError::transport("lock poisoned"))?;
            let local = guard
                .local
                .as_ref()
                .ok_or_else(|| DashError::transport("no local client"))?;
            f(local)
        } else {
            let guard = self
                .inner
                .lock()
                .map_err(|_| DashError::transport("lock poisoned"))?;
            let primary = guard
                .primary
                .as_ref()
                .ok_or_else(|| DashError::transport("no primary client"))?;
            f(primary)
        };
        match first {
            Ok(v) => Ok(v),
            Err(e) if e.is_transport() && !use_local => {
                self.switch();
                if retry {
                    self.with_read(false, f)
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }
}

impl<P, L, F> DashClient for FallbackClient<P, L, F>
where
    P: DashClient,
    L: DashClient,
    F: Fn() -> L + Send + Sync,
{
    fn call(&self, op: &str, params: Value) -> Result<Value, DashError> {
        self.with_read(false, |c| c.call(op, params.clone()))
    }
    fn snapshot(&self) -> Result<Value, DashError> {
        let result = self.with_read(true, |c| c.snapshot())?;
        if let Some(seq) = result.get("seq").and_then(Value::as_u64)
            && let Ok(mut inner) = self.inner.lock()
        {
            inner.seq = seq;
        }
        Ok(result)
    }
    fn supports(&self, op: &str) -> bool {
        let use_local = self.switched();
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if use_local {
            guard.local.as_ref().is_some_and(|c| c.supports(op))
        } else {
            guard.primary.as_ref().is_some_and(|c| c.supports(op))
        }
    }
    fn hello(&self) -> Result<Value, DashError> {
        self.with_read(true, |c| c.hello())
    }
    fn kind(&self) -> &'static str {
        if self.switched() { "inprocess" } else { "http" }
    }
}

/// Run a primary op; on a managed-work refusal, run the fallback steps in
/// order (`view-model/managed-root.ts`). Kept as a standalone helper so tests
/// can drive it with a plain closure.
pub fn with_managed_fallback(
    mut call: impl FnMut(&str, Value) -> Result<Value, DashError>,
    primary: &ManagedStep,
    fallback: &[ManagedStep],
    is_refusal: impl Fn(&DashError) -> bool,
) -> Result<Value, DashError> {
    match call(&primary.op, Value::Object(primary.params.clone())) {
        Ok(v) => Ok(v),
        Err(e) if is_refusal(&e) && !fallback.is_empty() => {
            let mut result = Err(e);
            for step in fallback {
                result = call(&step.op, Value::Object(step.params.clone()));
                if result.is_err() {
                    break;
                }
            }
            result
        }
        Err(e) => Err(e),
    }
}
