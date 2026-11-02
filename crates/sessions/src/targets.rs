//! Terminal recipes only; launch and filesystem admission remain in TypeScript.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct TargetError(&'static str);
impl From<&'static str> for TargetError {
    fn from(message: &'static str) -> Self {
        Self(message)
    }
}
pub const PRESETS: &[&str] = &[
    "ghostty",
    "iterm",
    "terminal-app",
    "wezterm",
    "kitty",
    "alacritty",
    "gnome-terminal",
    "x-terminal-emulator",
    "auto",
];
pub fn js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn attach_command(id: &str) -> Result<String, TargetError> {
    if !valid_task_id(id) {
        return Err("invalid session task id".into());
    }
    Ok(format!("pacer attach {id}"))
}
pub fn split_argv(template: &str) -> Result<Vec<String>, TargetError> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut active = false;
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && quote != Some('\'') {
            word.push(chars.next().ok_or("unfinished terminal escape")?);
            active = true;
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            active = true;
        } else if js_space(c) {
            if active {
                out.push(std::mem::take(&mut word));
                active = false;
            }
        } else {
            word.push(c);
            active = true;
        }
    }
    if quote.is_some() {
        return Err("unfinished terminal quote".into());
    }
    if active {
        out.push(word);
    }
    Ok(out)
}
pub fn validate_terminal_open(value: &str) -> Result<&str, TargetError> {
    if value.is_empty() {
        return Ok(value);
    }
    if value.encode_utf16().count() > 2000
        || value
            .chars()
            .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'))
    {
        return Err("invalid terminal.open".into());
    }
    if !PRESETS.contains(&value) && !value.contains("{cmd}") {
        return Err("terminal.open requires a preset or a template with {cmd}".into());
    }
    split_argv(value)?;
    Ok(value)
}
pub fn terminal_recipe(
    setting: &str,
    id: &str,
    platform: &str,
) -> Result<Vec<String>, TargetError> {
    validate_terminal_open(setting)?;
    let command = attach_command(id)?;
    let prefix: &[&str] = match setting {
        "ghostty" if platform == "darwin" => &["open", "-na", "Ghostty", "--args", "-e"],
        "ghostty" => &["ghostty", "-e"],
        "wezterm" => &["wezterm", "start", "--"],
        "kitty" => &["kitty"],
        "alacritty" => &["alacritty", "-e"],
        "gnome-terminal" => &["gnome-terminal", "--"],
        "x-terminal-emulator" => &["x-terminal-emulator", "-e"],
        "iterm" | "terminal-app" => {
            let script = if setting == "iterm" {
                format!(
                    "tell application \"iTerm\" to create window with default profile command \"{command}\""
                )
            } else {
                format!("tell application \"Terminal\" to do script \"{command}\"")
            };
            return Ok(vec!["osascript".into(), "-e".into(), script]);
        }
        _ => {
            let mut out = Vec::new();
            for arg in split_argv(setting)? {
                if arg == "{cmd}" {
                    out.extend(["pacer".into(), "attach".into(), id.into()]);
                } else {
                    out.push(arg.replace("{cmd}", &command));
                }
            }
            return Ok(out);
        }
    };
    Ok(prefix
        .iter()
        .copied()
        .chain(["pacer", "attach", id])
        .map(String::from)
        .collect())
}
