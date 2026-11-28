//! Terminal rendition of the design system, ported from `src/dashboard/theme.ts`.
//! The TUI shares token values and status semantics with the web app, never
//! Preact components (UI-20). Token hex values are copied from
//! `app/src/ds/tokens.json` so rendering never needs the TypeScript runtime.

#[cfg(test)]
mod tests;

use std::collections::HashMap;

pub type Env = HashMap<String, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ColorDepth {
    None,
    D16,
    D256,
    Truecolor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Appearance {
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Role {
    Ink,
    Secondary,
    Muted,
    Line,
    Good,
    Warn,
    Bad,
    Info,
    Accent,
    Focus,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub struct Style {
    pub fg: Option<Role>,
    pub agent: Option<String>,
    pub bold: bool,
    pub underline: bool,
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TerminalTheme {
    pub depth: ColorDepth,
    pub appearance: Appearance,
    pub unicode: bool,
    pub motion: bool,
    pub plain: bool,
}

/// Role → authored token (`ROLE_TOKENS` in theme.ts).
pub fn role_token(role: Role) -> &'static str {
    match role {
        Role::Ink => "ink",
        Role::Secondary => "ink-secondary",
        Role::Muted => "ink-muted",
        Role::Line => "line",
        Role::Good => "good-fg",
        Role::Warn => "warn-fg",
        Role::Bad => "bad-fg",
        Role::Info => "info-fg",
        Role::Accent => "track",
        Role::Focus => "focus",
    }
}

pub const ROLE_TOKENS: &[(Role, &str)] = &[
    (Role::Ink, "ink"),
    (Role::Secondary, "ink-secondary"),
    (Role::Muted, "ink-muted"),
    (Role::Line, "line"),
    (Role::Good, "good-fg"),
    (Role::Warn, "warn-fg"),
    (Role::Bad, "bad-fg"),
    (Role::Info, "info-fg"),
    (Role::Accent, "track"),
    (Role::Focus, "focus"),
];

const SELECTION_TOKEN: &str = "surface-lane";

/// The 16-color fallback uses the terminal's own palette.
fn ansi16(role: Role) -> &'static str {
    match role {
        Role::Muted | Role::Line => "2",
        Role::Good => "32",
        Role::Warn => "33",
        Role::Bad => "31",
        Role::Info => "36",
        Role::Focus => "34",
        _ => "",
    }
}

/// Authored token hex values from `app/src/ds/tokens.json`, copied at port time
/// (P11 keeps the source JSON canonical). Entries without a `#rrggbb` value are
/// intentionally absent, matching `tokenHex`'s validation in theme.ts.
const TOKENS: &[(&str, &str, &str)] = &[
    ("surface-page", "#ffffff", "#09090b"),
    ("surface-card", "#fafafa", "#18181b"),
    ("surface-lane", "#f4f4f5", "#27272a"),
    ("line", "#e4e4e7", "#3f3f46"),
    ("ink", "#18181b", "#fafafa"),
    ("ink-secondary", "#52525b", "#a1a1aa"),
    ("ink-muted", "#6b6b74", "#a1a1aa"),
    ("ink-on-ink", "#ffffff", "#18181b"),
    ("track", "#65a30d", "#a3e635"),
    ("link", "#1d4ed8", "#93c5fd"),
    ("good-fg", "#166534", "#86efac"),
    ("good-bg", "#dcfce7", "#14532d"),
    ("good-fill", "#15803d", "#22c55e"),
    ("warn-fg", "#92400e", "#fcd34d"),
    ("warn-bg", "#fef3c7", "#451a03"),
    ("warn-fill", "#d97706", "#f59e0b"),
    ("warn-line", "#fde68a", "#78350f"),
    ("warn-tint", "#fffdf5", "#1c1408"),
    ("bad-fg", "#991b1b", "#fca5a5"),
    ("bad-bg", "#fee2e2", "#450a0a"),
    ("bad-fill", "#dc2626", "#ef4444"),
    ("bad-line", "#fecaca", "#7f1d1d"),
    ("bad-tint", "#fffbfb", "#1f0a0a"),
    ("info-fg", "#1e40af", "#93c5fd"),
    ("info-bg", "#dbeafe", "#172554"),
    ("focus", "#1d4ed8", "#93c5fd"),
    ("brand-tile", "#18181b", "#18181b"),
    ("brand-lane", "#52525b", "#52525b"),
    ("brand-ink", "#ffffff", "#ffffff"),
    ("brand-tick", "#a3e635", "#a3e635"),
    ("agent-claude-code", "#D97757", "#D97757"),
    ("agent-agy", "#4285F4", "#4285F4"),
    ("agent-byteplus", "#3C8CFF", "#3C8CFF"),
    ("agent-gemini", "#8E75B2", "#8E75B2"),
    ("traffic-close", "#ff5f56", "#ff5f56"),
    ("traffic-min", "#ffbd2e", "#ffbd2e"),
    ("traffic-max", "#27ca40", "#27ca40"),
    ("chart-1", "#4f7a94", "#7da4bb"),
    ("chart-2", "#b97d5a", "#d5a68a"),
    ("chart-3", "#7588c7", "#a5b2df"),
    ("chart-4", "#7f8f6f", "#9baa8b"),
    ("chart-5", "#918977", "#c6c1b5"),
    ("aurora-1", "#a5b4fc", "#818cf8"),
    ("aurora-2", "#f0abfc", "#d58be8"),
    ("aurora-3", "#99f6e4", "#5ed8c4"),
];

fn token_hex(name: &str, appearance: Appearance) -> Option<&'static str> {
    TOKENS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, light, dark)| match appearance {
            Appearance::Light => *light,
            Appearance::Dark => *dark,
        })
        .filter(|hex| {
            hex.len() == 7
                && hex.starts_with('#')
                && hex[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
}

fn rgb(hex: &str) -> [u32; 3] {
    [
        u32::from_str_radix(&hex[1..3], 16).unwrap_or(0),
        u32::from_str_radix(&hex[3..5], 16).unwrap_or(0),
        u32::from_str_radix(&hex[5..7], 16).unwrap_or(0),
    ]
}

const CUBE: [u32; 6] = [0, 95, 135, 175, 215, 255];

/// Nearest xterm-256 index from the 6x6x6 cube or the grey ramp.
pub fn hex_to_256(hex: &str) -> u32 {
    let [r, g, b] = rgb(hex);
    let nearest = |v: u32| -> usize {
        let mut best = 0usize;
        for (i, &level) in CUBE.iter().enumerate() {
            if diff(level, v) < diff(CUBE[best], v) {
                best = i;
            }
        }
        best
    };
    let (ri, gi, bi) = (nearest(r), nearest(g), nearest(b));
    let cube = [CUBE[ri], CUBE[gi], CUBE[bi]];
    let avg = (r + g + b) as f64 / 3.0;
    let grey = (((avg - 8.0) / 10.0) + 0.5).floor() as i64;
    let grey = grey.clamp(0, 23) as u32;
    let grey_value = 8 + grey * 10;
    let dist = |c: &[u32; 3]| -> i64 {
        (c[0] as i64 - r as i64).pow(2)
            + (c[1] as i64 - g as i64).pow(2)
            + (c[2] as i64 - b as i64).pow(2)
    };
    if dist(&[grey_value, grey_value, grey_value]) < dist(&cube) {
        232 + grey
    } else {
        16 + 36 * ri as u32 + 6 * gi as u32 + bi as u32
    }
}

fn diff(a: u32, b: u32) -> u32 {
    a.abs_diff(b)
}

fn color_code(theme: &TerminalTheme, hex: &str, layer: &str) -> String {
    let base = if layer == "fg" { 38 } else { 48 };
    if theme.depth == ColorDepth::Truecolor {
        let [r, g, b] = rgb(hex);
        format!("\x1b[{base};2;{r};{g};{b}m")
    } else {
        format!("\x1b[{base};5;{}m", hex_to_256(hex))
    }
}

/// The canonical id for an agent name or alias (from `view-model/agents.ts`).
fn agent_key(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("claude-code"),
        "antigravity" => Some("agy"),
        "claude-code" => Some("claude-code"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "agy" => Some("agy"),
        "byteplus" => Some("byteplus"),
        "local" => Some("local"),
        "opencode" => Some("opencode"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

pub fn agent_token(agent: &str) -> Option<&'static str> {
    match agent_key(agent)? {
        "claude-code" => Some("agent-claude-code"),
        "agy" => Some("agent-agy"),
        "byteplus" => Some("agent-byteplus"),
        "gemini" => Some("agent-gemini"),
        _ => None,
    }
}

pub struct Sgr {
    pub open: String,
    pub close: String,
}

pub fn sgr(theme: &TerminalTheme, style: &Style) -> Sgr {
    if theme.depth == ColorDepth::None {
        return Sgr {
            open: String::new(),
            close: String::new(),
        };
    }
    let mut open = String::new();
    if style.bold {
        open.push_str("\x1b[1m");
    }
    if style.underline {
        open.push_str("\x1b[4m");
    }
    if theme.depth == ColorDepth::D16 {
        let code = style.fg.map(ansi16).unwrap_or("");
        if !code.is_empty() {
            open.push_str(&format!("\x1b[{code}m"));
        }
        if style.selected {
            open.push_str("\x1b[7m");
        }
    } else {
        let agent = style.agent.as_deref().and_then(agent_token);
        let role = if style.selected && style.fg == Some(Role::Muted) {
            Some(Role::Secondary)
        } else {
            style.fg
        };
        let fg = if let Some(agent) = agent {
            token_hex(agent, theme.appearance)
        } else if let Some(role) = role {
            token_hex(role_token(role), theme.appearance)
        } else {
            None
        };
        if let Some(fg) = fg {
            open.push_str(&color_code(theme, fg, "fg"));
        }
        if style.selected
            && let Some(bg) = token_hex(SELECTION_TOKEN, theme.appearance)
        {
            open.push_str(&color_code(theme, bg, "bg"));
        }
    }
    if open.is_empty() {
        Sgr {
            open: String::new(),
            close: String::new(),
        }
    } else {
        Sgr {
            open,
            close: "\x1b[0m".to_string(),
        }
    }
}

fn depth_from(env: &Env, is_tty: bool) -> ColorDepth {
    if env.contains_key("NO_COLOR") {
        return ColorDepth::None;
    }
    if let Some(forced) = env.get("PACER_COLOR").and_then(|v| match v.as_str() {
        "none" => Some(ColorDepth::None),
        "16" => Some(ColorDepth::D16),
        "256" => Some(ColorDepth::D256),
        "truecolor" => Some(ColorDepth::Truecolor),
        _ => None,
    }) {
        return forced;
    }
    if let Some(value) = env.get("FORCE_COLOR") {
        let level = if value.is_empty() || value == "true" {
            1.0
        } else {
            js_number(value)
        };
        if level == 0.0 {
            return ColorDepth::None;
        }
        if level >= 1.0 {
            return if level >= 3.0 {
                ColorDepth::Truecolor
            } else if level == 2.0 {
                ColorDepth::D256
            } else {
                ColorDepth::D16
            };
        }
    }
    if !is_tty || env.get("TERM").map(String::as_str) == Some("dumb") {
        return ColorDepth::None;
    }
    let colorterm = env.get("COLORTERM").map(String::as_str).unwrap_or("");
    if colorterm.eq_ignore_ascii_case("truecolor") || colorterm.eq_ignore_ascii_case("24bit") {
        return ColorDepth::Truecolor;
    }
    if env
        .get("TERM")
        .map(String::as_str)
        .unwrap_or("")
        .contains("256")
    {
        ColorDepth::D256
    } else {
        ColorDepth::D16
    }
}

/// A minimal ECMAScript `Number(string)` used for FORCE_COLOR / COLORFGBG.
fn js_number(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() {
        return 0.0;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

fn appearance_from(env: &Env) -> Appearance {
    match env.get("PACER_THEME").map(String::as_str) {
        Some("light") => return Appearance::Light,
        Some("dark") => return Appearance::Dark,
        _ => {}
    }
    let bg = env
        .get("COLORFGBG")
        .and_then(|v| v.rsplit(';').next())
        .map(js_number)
        .unwrap_or(f64::NAN);
    if bg == 7.0 || bg == 15.0 {
        Appearance::Light
    } else {
        Appearance::Dark
    }
}

fn unicode_from(env: &Env) -> bool {
    if env.get("PACER_ASCII").map(String::as_str) == Some("1") {
        return false;
    }
    let locale = env
        .get("LC_ALL")
        .or_else(|| env.get("LC_CTYPE"))
        .or_else(|| env.get("LANG"));
    match locale.map(String::as_str) {
        None | Some("") => true,
        Some(s) => {
            let lower = s.to_ascii_lowercase();
            lower.contains("utf-8") || lower.contains("utf8")
        }
    }
}

/// Detect once at start-up; callers pass explicit env so frames never depend on
/// the host terminal.
pub fn detect_theme(env: &Env, is_tty: bool, plain: bool) -> TerminalTheme {
    if plain || env.get("PACER_PLAIN").map(String::as_str) == Some("1") {
        return TerminalTheme {
            depth: ColorDepth::None,
            appearance: appearance_from(env),
            unicode: false,
            motion: false,
            plain: true,
        };
    }
    TerminalTheme {
        depth: depth_from(env, is_tty),
        appearance: appearance_from(env),
        unicode: unicode_from(env),
        motion: !env.contains_key("PACER_NO_ANIM"),
        plain: false,
    }
}

/// A fixed theme for golden frames.
pub const PLAIN_THEME: TerminalTheme = TerminalTheme {
    depth: ColorDepth::None,
    appearance: Appearance::Dark,
    unicode: true,
    motion: false,
    plain: false,
};
