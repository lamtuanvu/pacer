//! Navigation, selection and overlays for the TUI, ported from
//! `src/dashboard/state.ts`. Pure: keys become a new state and, at most, one
//! effect. All data types are serde-serializable so the TS goldens can be
//! replayed byte-for-byte.

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type ScreenId = String;

pub fn screen_key(key: &str) -> Option<&'static str> {
    match key {
        "1" => Some("home"),
        "2" => Some("review"),
        "3" => Some("sessions"),
        "4" => Some("settings"),
        "5" => Some("setup"),
        _ => None,
    }
}

/// What an action does. The controller executes effects; screens only describe them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Effect {
    Refresh,
    Quit,
    #[serde(rename = "history-more")]
    HistoryMore,
    /// `fallback`: managed `dispatch.*` steps run when the service refuses the
    /// action for managed work (`view-model/managed-root`).
    Action {
        action: Action,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback: Option<Vec<ManagedStep>>,
    },
    Navigate {
        screen: ScreenId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        section: Option<String>,
    },
    Attach {
        id: String,
        target: String,
    },
    /// The reducer opens these as overlays; the controller ignores them.
    Prompt {
        #[serde(rename = "prompt")]
        spec: PromptSpec,
    },
    Choose {
        title: String,
        options: Vec<Act>,
    },
    Handoff {
        argv: Vec<String>,
        label: String,
    },
    /// Controller flows that need a read before asking, such as an integration preview.
    Flow {
        name: String,
        params: Map<String, Value>,
    },
    Local {
        #[serde(default)]
        label: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManagedStep {
    pub op: String,
    pub params: Map<String, Value>,
}

/// An operation the controller can run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Action {
    pub label: String,
    pub op: String,
    pub params: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
}

/// A consent question. `alt` offers a second answer ("Change only" beside
/// "Change and connect").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Confirm {
    pub title: String,
    #[serde(default)]
    pub body: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<Alt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Alt {
    pub key: String,
    pub label: String,
    pub act: Box<Act>,
}

/// A selectable action. Destructive actions ask first (TD-6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Act {
    pub label: String,
    pub effect: Effect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<Confirm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub danger: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

/// A declarative representation of `PromptSpec.submit`. In TypeScript this is
/// a closure; for golden replay it is a value describing the effect produced.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Submit {
    /// Produce an action effect.
    Action(Action),
    /// Chain to another prompt.
    Prompt(Box<PromptSpec>),
    /// Return undefined, closing the overlay.
    #[default]
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PromptSpec {
    pub title: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<String>,
    /// Not serialized: TypeScript's `submit` is a function, so JSON.stringify
    /// omits it too. Rebuild it from the script when replaying.
    #[serde(skip)]
    pub submit: Submit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Overlay {
    Help {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scroll: Option<i64>,
    },
    Menu {
        title: String,
        actions: Vec<Act>,
        index: usize,
    },
    Confirm {
        title: String,
        #[serde(default)]
        body: Vec<String>,
        yes: String,
        act: Box<Act>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alt: Option<Alt>,
    },
    Prompt {
        spec: PromptSpec,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UiState {
    pub screen: ScreenId,
    /// Selected item id per screen; ids survive refreshes unlike indexes.
    #[serde(default)]
    pub selected: std::collections::BTreeMap<ScreenId, String>,
    /// Settings section id.
    #[serde(default = "default_section")]
    pub section: String,
    #[serde(default = "default_focus")]
    pub focus: String,
    #[serde(default)]
    pub scroll: i64,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub overlay: Option<Overlay>,
}

fn default_section() -> String {
    "planner".to_string()
}
fn default_focus() -> String {
    "list".to_string()
}

pub fn initial_state() -> UiState {
    initial_state_for("home")
}

pub fn initial_state_for(screen: &str) -> UiState {
    UiState {
        screen: screen.to_string(),
        selected: std::collections::BTreeMap::new(),
        section: "planner".to_string(),
        focus: "list".to_string(),
        scroll: 0,
        scope: None,
        overlay: None,
    }
}

/// A selectable row. `primary` is the region's one primary action (UI-14).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<Act>,
    #[serde(default)]
    pub actions: Vec<Act>,
    #[serde(default)]
    pub keys: std::collections::BTreeMap<String, Act>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyContext {
    /// Selectable rows of the visible list, in order.
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub tabs: Vec<ScreenId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<String>>,
    /// Body lines per page, for PgUp/PgDn.
    #[serde(default = "default_page")]
    pub page: i64,
    #[serde(default)]
    pub wide: bool,
    #[serde(default)]
    pub has_detail: bool,
    #[serde(default)]
    pub repos: Vec<String>,
    /// Ops offered by the service; global keys whose ops are absent do nothing.
    /// An empty list means "all supported".
    #[serde(default)]
    pub ops: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial: Option<String>,
}

fn default_page() -> i64 {
    1
}

impl Default for KeyContext {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            tabs: Vec::new(),
            sections: None,
            page: 1,
            wide: false,
            has_detail: false,
            repos: Vec::new(),
            ops: Vec::new(),
            initial: None,
        }
    }
}

impl KeyContext {
    pub fn supports(&self, op: &str) -> bool {
        self.ops.is_empty() || self.ops.iter().any(|o| o == op)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyResult {
    pub state: UiState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<Effect>,
    #[serde(default)]
    pub quit: bool,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip)]
    pub act: Option<Act>,
}

fn value_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

fn index(items: &[Item], id: Option<&String>) -> i64 {
    id.and_then(|id| items.iter().position(|i| &i.id == id))
        .map(|i| i as i64)
        .unwrap_or(0)
}

/// The selected row, else the screen's suggested row, else the first.
fn selected_item<'a>(
    state: &UiState,
    items: &'a [Item],
    initial: Option<&str>,
) -> Option<&'a Item> {
    let id = state.selected.get(&state.screen);
    if id.map(String::as_str) == Some("") {
        return None;
    }
    items
        .iter()
        .find(|i| Some(&i.id) == id)
        .or_else(|| items.iter().find(|i| Some(i.id.as_str()) == initial))
        .or_else(|| items.first())
}

fn select(state: &UiState, items: &[Item], i: i64) -> UiState {
    let upper = items.len().saturating_sub(1) as i64;
    let at = i.clamp(0, upper) as usize;
    match items.get(at) {
        Some(item) => {
            let mut next = state.clone();
            next.selected.insert(state.screen.clone(), item.id.clone());
            next.scroll = 0;
            next
        }
        None => state.clone(),
    }
}

fn go(state: &UiState, screen: &str) -> UiState {
    let mut next = state.clone();
    next.screen = screen.to_string();
    next.focus = "list".to_string();
    next.scroll = 0;
    next.overlay = None;
    next
}

/// Accept/reject verdicts, stops, removals, updates and danger-style service
/// actions always confirm in the TUI, whichever screen or menu offers them (TD-6).
pub fn consequential(action: &Action) -> bool {
    let verdict = action
        .params
        .get("verdict")
        .map(value_string)
        .unwrap_or_default();
    (action.op == "task.review" && (verdict == "accept" || verdict == "reject"))
        || action.op == "task.stop"
        || action.op.ends_with(".remove")
        || action.op == "update.apply"
        || action.style.as_deref() == Some("danger")
}

fn verdict_word(action: &Action) -> Option<String> {
    if action.op != "task.review" {
        return None;
    }
    let verdict = action.params.get("verdict").map(value_string)?;
    match verdict.as_str() {
        "accept" => Some("Accept".to_string()),
        "reject" => Some("Reject".to_string()),
        _ => None,
    }
}

fn guard_confirm(act: &Act) -> Option<Confirm> {
    if act.confirm.is_some() {
        return act.confirm.clone();
    }
    let Effect::Action { action, .. } = &act.effect else {
        return None;
    };
    if !consequential(action) {
        return None;
    }
    let word = verdict_word(action);
    Some(Confirm {
        title: format!("{}?", word.as_deref().unwrap_or(&act.label)),
        body: act.subject.iter().cloned().collect(),
        yes: Some(word.unwrap_or_else(|| act.label.clone())),
        alt: None,
    })
}

/// Run an act: confirm first when it asks to, or when it is consequential.
/// `confirmed` skips the question.
pub fn trigger(state: &UiState, act: Option<&Act>, confirmed: bool) -> KeyResult {
    let Some(act) = act else {
        return KeyResult {
            state: state.clone(),
            effect: None,
            quit: false,
            refresh: false,
            act: None,
        };
    };
    if !confirmed && let Some(confirm) = guard_confirm(act) {
        let mut confirmed_act = act.clone();
        confirmed_act.confirm = Some(confirm.clone());
        let yes = confirm.yes.unwrap_or_else(|| act.label.clone());
        return KeyResult {
            state: UiState {
                overlay: Some(Overlay::Confirm {
                    title: confirm.title,
                    body: confirm.body,
                    yes,
                    act: Box::new(confirmed_act.clone()),
                    alt: confirm.alt,
                }),
                ..state.clone()
            },
            effect: None,
            quit: false,
            refresh: false,
            act: Some(confirmed_act),
        };
    }
    match &act.effect {
        Effect::Prompt { spec } => KeyResult {
            state: UiState {
                overlay: Some(Overlay::Prompt {
                    value: spec.value.clone().unwrap_or_default(),
                    spec: spec.clone(),
                    error: None,
                }),
                ..state.clone()
            },
            effect: None,
            quit: false,
            refresh: false,
            act: None,
        },
        Effect::Choose { title, options } => KeyResult {
            state: UiState {
                overlay: Some(Overlay::Menu {
                    title: title.clone(),
                    actions: options.clone(),
                    index: 0,
                }),
                ..state.clone()
            },
            effect: None,
            quit: false,
            refresh: false,
            act: None,
        },
        _ => KeyResult {
            state: state.clone(),
            effect: Some(act.effect.clone()),
            quit: false,
            refresh: false,
            act: Some(act.clone()),
        },
    }
}

fn close_state(state: &UiState) -> UiState {
    UiState {
        overlay: None,
        ..state.clone()
    }
}

const NAV_KEYS: &[&str] = &[
    "up", "down", "left", "right", "tab", "backtab", "pageup", "pagedown",
];

fn overlay_key(state: &UiState, overlay: &Overlay, key: &str, page: i64) -> KeyResult {
    let close = close_state(state);
    let idle = || KeyResult {
        state: state.clone(),
        effect: None,
        quit: false,
        refresh: false,
        act: None,
    };
    let closed = || KeyResult {
        state: close.clone(),
        effect: None,
        quit: false,
        refresh: false,
        act: None,
    };
    match overlay {
        Overlay::Help { scroll } => {
            let step = match key {
                "down" | "j" => 1,
                "up" | "k" => -1,
                "pagedown" => page,
                "pageup" => -page,
                _ => 0,
            };
            if step != 0 {
                let next = (scroll.unwrap_or(0) + step).clamp(0, 200);
                return KeyResult {
                    state: UiState {
                        overlay: Some(Overlay::Help { scroll: Some(next) }),
                        ..state.clone()
                    },
                    effect: None,
                    quit: false,
                    refresh: false,
                    act: None,
                };
            }
            if matches!(key, "?" | "escape" | "q" | "enter") {
                closed()
            } else {
                idle()
            }
        }
        Overlay::Confirm { act, alt, .. } => {
            if matches!(key, "y" | "Y" | "enter") {
                let mut plain = act.as_ref().clone();
                plain.confirm = None;
                return trigger(&close, Some(&plain), true);
            }
            if let Some(alt) = alt
                && key == alt.key
            {
                return trigger(&close, Some(&alt.act), true);
            }
            if matches!(key, "n" | "N" | "escape") {
                closed()
            } else {
                idle()
            }
        }
        Overlay::Menu {
            title,
            actions,
            index,
        } => {
            if key == "escape" {
                return closed();
            }
            if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() {
                let n = key.as_bytes()[0] - b'1';
                if (n as usize) < actions.len() {
                    return trigger(&close, actions.get(n as usize), false);
                }
                return idle();
            }
            if key == "enter" {
                return trigger(&close, actions.get(*index), false);
            }
            let move_ = match key {
                "up" | "k" => -1,
                "down" | "j" => 1,
                _ => 0,
            };
            if move_ != 0 {
                let next = ((*index as i64) + move_)
                    .clamp(0, actions.len().saturating_sub(1) as i64)
                    as usize;
                return KeyResult {
                    state: UiState {
                        overlay: Some(Overlay::Menu {
                            title: title.clone(),
                            actions: actions.clone(),
                            index: next,
                        }),
                        ..state.clone()
                    },
                    effect: None,
                    quit: false,
                    refresh: false,
                    act: None,
                };
            }
            idle()
        }
        Overlay::Prompt {
            spec,
            value,
            error: _,
        } => {
            if key == "escape" {
                return closed();
            }
            if key == "backspace" {
                let mut chars: Vec<char> = value.chars().collect();
                chars.pop();
                return KeyResult {
                    state: UiState {
                        overlay: Some(Overlay::Prompt {
                            spec: spec.clone(),
                            value: chars.into_iter().collect(),
                            error: None,
                        }),
                        ..state.clone()
                    },
                    effect: None,
                    quit: false,
                    refresh: false,
                    act: None,
                };
            }
            if key == "enter" {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty()
                    && let Some(required) = &spec.required
                {
                    return KeyResult {
                        state: UiState {
                            overlay: Some(Overlay::Prompt {
                                spec: spec.clone(),
                                value: value.clone(),
                                error: Some(required.clone()),
                            }),
                            ..state.clone()
                        },
                        effect: None,
                        quit: false,
                        refresh: false,
                        act: None,
                    };
                }
                let effect = match &spec.submit {
                    Submit::Action(action) => Some(Effect::Action {
                        action: action.clone(),
                        fallback: None,
                    }),
                    Submit::Prompt(next) => Some(Effect::Prompt {
                        spec: (**next).clone(),
                    }),
                    Submit::None => None,
                };
                return match effect {
                    Some(effect) => trigger(
                        &close,
                        Some(&Act {
                            label: spec.title.clone(),
                            effect,
                            confirm: None,
                            danger: None,
                            subject: None,
                        }),
                        true,
                    ),
                    None => closed(),
                };
            }
            if !key.is_empty()
                && !NAV_KEYS.contains(&key)
                && !key.chars().any(|c| (c as u32) <= 0x1f || c == '\x7f')
            {
                return KeyResult {
                    state: UiState {
                        overlay: Some(Overlay::Prompt {
                            spec: spec.clone(),
                            value: format!("{value}{key}"),
                            error: None,
                        }),
                        ..state.clone()
                    },
                    effect: None,
                    quit: false,
                    refresh: false,
                    act: None,
                };
            }
            idle()
        }
    }
}

/// Global and list keys. Screen keys come from the selected item's `keys`.
pub fn reduce_key(state: &UiState, key: &str, ctx: &KeyContext) -> KeyResult {
    let idle = || KeyResult {
        state: state.clone(),
        effect: None,
        quit: false,
        refresh: false,
        act: None,
    };
    if key == "interrupt" {
        return KeyResult {
            state: state.clone(),
            effect: None,
            quit: true,
            refresh: false,
            act: None,
        };
    }
    if let Some(overlay) = &state.overlay {
        return overlay_key(state, overlay, key, ctx.page);
    }
    let item = selected_item(state, &ctx.items, ctx.initial.as_deref());
    let detail = state.focus == "detail";

    // Inside a settings section, row keys (including left/right) win over navigation.
    if state.screen == "settings"
        && detail
        && let Some(act) = item.and_then(|i| i.keys.get(key))
    {
        return trigger(state, Some(act), false);
    }
    // Settings section navigation: the list of sections is the outer level.
    if state.screen == "settings"
        && let Some(sections) = &ctx.sections
        && !detail
    {
        let i = sections
            .iter()
            .position(|s| s == &state.section)
            .map(|p| p as i64)
            .unwrap_or(0);
        if key == "up" || key == "k" {
            let mut next = state.clone();
            next.section = sections
                [(i - 1).clamp(0, sections.len().saturating_sub(1) as i64) as usize]
                .clone();
            next.scroll = 0;
            return KeyResult {
                state: next,
                ..idle()
            };
        }
        if key == "down" || key == "j" {
            let mut next = state.clone();
            next.section = sections
                [(i + 1).clamp(0, sections.len().saturating_sub(1) as i64) as usize]
                .clone();
            next.scroll = 0;
            return KeyResult {
                state: next,
                ..idle()
            };
        }
        if matches!(key, "enter" | "right" | "l") {
            let mut next = state.clone();
            next.focus = "detail".to_string();
            next.scroll = 0;
            return KeyResult {
                state: next,
                ..idle()
            };
        }
    }
    if key == "escape" || key == "left" || (key == "h" && detail) {
        if detail {
            let mut next = state.clone();
            next.focus = "list".to_string();
            next.scroll = 0;
            return KeyResult {
                state: next,
                ..idle()
            };
        }
        if key == "escape" && state.screen == "settings" {
            return KeyResult {
                state: go(state, "home"),
                ..idle()
            };
        }
        if key == "escape" {
            return idle();
        }
    }
    if key == "q" {
        return KeyResult {
            state: state.clone(),
            effect: None,
            quit: true,
            refresh: false,
            act: None,
        };
    }
    if key == "?" {
        return KeyResult {
            state: UiState {
                overlay: Some(Overlay::Help { scroll: None }),
                ..state.clone()
            },
            effect: None,
            quit: false,
            refresh: false,
            act: None,
        };
    }
    if let Some(screen) = screen_key(key)
        && ctx.tabs.iter().any(|t| t == screen)
    {
        return KeyResult {
            state: go(state, screen),
            ..idle()
        };
    }
    if matches!(key, "tab" | "backtab") {
        if !ctx.tabs.is_empty() {
            let i = ctx
                .tabs
                .iter()
                .position(|t| t == &state.screen)
                .map(|p| p as i64)
                .unwrap_or(0);
            let step = if key == "tab" { 1 } else { -1 };
            let len = ctx.tabs.len() as i64;
            let next = ((i + step + len) % len) as usize;
            return KeyResult {
                state: go(state, &ctx.tabs[next]),
                ..idle()
            };
        }
        return idle();
    }
    if key == "," {
        return KeyResult {
            state: go(state, "settings"),
            ..idle()
        };
    }
    if key == "R" || key == "\x12" {
        return KeyResult {
            state: state.clone(),
            effect: None,
            quit: false,
            refresh: true,
            act: None,
        };
    }
    if key == "f" && state.screen != "settings" {
        let mut scopes: Vec<Option<String>> = vec![None];
        scopes.extend(ctx.repos.iter().cloned().map(Some));
        let i = scopes
            .iter()
            .position(|s| *s == state.scope)
            .map(|p| p as i64)
            .unwrap_or(0);
        let next = ((i + 1) % scopes.len() as i64) as usize;
        let mut state = state.clone();
        state.scope = scopes[next].clone();
        state.selected.clear();
        return KeyResult { state, ..idle() };
    }

    // Narrow detail drill-in scrolls; wide detail is always visible.
    if detail && state.screen != "settings" {
        if key == "up" || key == "k" {
            let mut next = state.clone();
            next.scroll = (next.scroll - 1).max(0);
            return KeyResult {
                state: next,
                ..idle()
            };
        }
        if key == "down" || key == "j" {
            let mut next = state.clone();
            next.scroll += 1;
            return KeyResult {
                state: next,
                ..idle()
            };
        }
    }

    let i = index(&ctx.items, state.selected.get(&state.screen));
    if key == "up" || key == "k" {
        return KeyResult {
            state: select(state, &ctx.items, i - 1),
            ..idle()
        };
    }
    if key == "down" || key == "j" {
        return KeyResult {
            state: select(state, &ctx.items, i + 1),
            ..idle()
        };
    }
    if key == "pageup" {
        return KeyResult {
            state: select(state, &ctx.items, i - ctx.page.max(1)),
            ..idle()
        };
    }
    if key == "pagedown" {
        return KeyResult {
            state: select(state, &ctx.items, i + ctx.page.max(1)),
            ..idle()
        };
    }
    if key == "home" {
        return KeyResult {
            state: select(state, &ctx.items, 0),
            ..idle()
        };
    }
    if key == "end" {
        return KeyResult {
            state: select(state, &ctx.items, ctx.items.len() as i64 - 1),
            ..idle()
        };
    }
    if (key == "right" || key == "l") && ctx.has_detail && !ctx.wide && item.is_some() {
        let mut next = state.clone();
        next.focus = "detail".to_string();
        next.scroll = 0;
        return KeyResult {
            state: next,
            ..idle()
        };
    }
    if key == "." {
        let mut actions: Vec<Act> = Vec::new();
        if let Some(item) = item {
            if let Some(primary) = &item.primary {
                actions.push(primary.clone());
            }
            actions.extend(item.actions.iter().cloned());
        }
        if actions.is_empty() {
            return idle();
        }
        return KeyResult {
            state: UiState {
                overlay: Some(Overlay::Menu {
                    title: "Actions".to_string(),
                    actions,
                    index: 0,
                }),
                ..state.clone()
            },
            effect: None,
            quit: false,
            refresh: false,
            act: None,
        };
    }
    if key == "enter" {
        if ctx.has_detail && !ctx.wide && !detail && item.is_some_and(|i| i.primary.is_none()) {
            let mut next = state.clone();
            next.focus = "detail".to_string();
            next.scroll = 0;
            return KeyResult {
                state: next,
                ..idle()
            };
        }
        return trigger(state, item.and_then(|i| i.primary.as_ref()), false);
    }
    if let Some(act) = item.and_then(|i| i.keys.get(key)) {
        return trigger(state, Some(act), false);
    }
    idle()
}
