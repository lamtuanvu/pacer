//! Exact title fallback order and prose compaction from view-model/titles and core/goal-title.
use crate::{js_whitespace, model::text};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;
static CODE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"```[^\n]*\n[\s\S]*?(?:```|$)").ok());
static LINK: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"!?\[([^\]]+)\]\(").ok());
static REF: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"!?\[([^\]]+)\]\[[^\]]*\]").ok());
static PREFIX: LazyLock<Option<Regex>> = LazyLock::new(|| {
    let ws = r"[\u{0009}-\u{000d}\u{0020}\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
    Regex::new(&format!(
        r"^{ws}*(?:(?:#{{1,6}}{ws}*|>{ws}*|[-+*]{ws}+|[0-9]+[.)]{ws}+))+"
    ))
    .ok()
});
fn balanced(s: &str) -> String {
    let mut stack = vec![];
    for (i, c) in s.char_indices() {
        if "([{“".contains(c) {
            stack.push((c, i));
        } else if ")]}”".contains(c)
            && stack.last().is_some_and(|(o, _)| {
                "([{“".chars().position(|c| c == *o) == ")]}”".chars().position(|x| x == c)
            })
        {
            stack.pop();
        }
    }
    s[..stack.first().map(|(_, i)| *i).unwrap_or(s.len())]
        .trim_matches(js_whitespace)
        .into()
}
fn links(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(caps) = LINK.as_ref().and_then(|r| r.captures(rest)) {
        let Some(m) = caps.get(0) else {
            break;
        };
        let Some(label) = caps.get(1) else {
            break;
        };
        out.push_str(&rest[..m.start()]);
        out.push_str(label.as_str());
        let mut depth = 1;
        let mut end = m.end();
        for (i, c) in rest[m.end()..].char_indices() {
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
            }
            end = m.end() + i + c.len_utf8();
            if depth == 0 {
                break;
            }
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}
fn letter_number(c: char) -> bool {
    use unicode_general_category::{GeneralCategory::*, get_general_category as category};
    matches!(
        category(c),
        UppercaseLetter
            | LowercaseLetter
            | TitlecaseLetter
            | ModifierLetter
            | OtherLetter
            | DecimalNumber
            | LetterNumber
            | OtherNumber
    )
}
pub fn title(t: &Value) -> String {
    let full = text(&t["fullTitle"]).trim_matches(js_whitespace);
    if !full.is_empty() {
        return full.into();
    }
    let title = text(&t["title"]).trim_matches(js_whitespace);
    let goal = text(&t["goal"]);
    let generated = title == goal.trim_matches(js_whitespace)
        || ((title.ends_with('…') || balanced(title) != title)
            && goal
                .trim_matches(js_whitespace)
                .starts_with(title.strip_suffix('…').unwrap_or(title)));
    if !title.is_empty() && !generated {
        return title.into();
    }
    let limited = String::from_utf16_lossy(&goal.encode_utf16().take(4000).collect::<Vec<_>>());
    let stripped = CODE
        .as_ref()
        .map(|r| r.replace_all(&limited, "").into_owned())
        .unwrap_or(limited);
    for raw in stripped.split('\n') {
        let mut plain = links(raw);
        if let Some(r) = REF.as_ref() {
            plain = r.replace_all(&plain, "$1").into_owned();
        }
        if let Some(r) = PREFIX.as_ref() {
            plain = r.replace(&plain, "").into_owned();
        }
        plain.retain(|c| !matches!(c, '`' | '*' | '~'));
        let chars: Vec<char> = plain.chars().collect();
        plain = chars
            .iter()
            .enumerate()
            .filter(|(i, c)| {
                **c != '_'
                    || (*i > 0
                        && letter_number(chars[*i - 1])
                        && chars.get(i + 1).is_some_and(|c| letter_number(*c)))
            })
            .map(|(_, c)| *c)
            .collect();
        let trimmed = plain.trim_end_matches(js_whitespace);
        if trimmed.ends_with('#') {
            let prefix = trimmed.trim_end_matches('#');
            if prefix.chars().last().is_some_and(js_whitespace) {
                plain = prefix.trim_end_matches(js_whitespace).into();
            }
        }
        plain = plain
            .split(js_whitespace)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if plain.is_empty()
            || matches!(
                plain.trim_end_matches(':').to_lowercase().as_str(),
                "goal" | "task" | "summary" | "context"
            )
        {
            continue;
        }
        let end = plain
            .char_indices()
            .find(|(i, c)| {
                matches!(c, '.' | '!' | '?')
                    && (plain[i + c.len_utf8()..]
                        .chars()
                        .next()
                        .is_none_or(js_whitespace))
            })
            .map(|(i, _)| i)
            .unwrap_or(plain.len());
        let sentence = balanced(&plain[..end]);
        if sentence.is_empty() {
            continue;
        }
        if sentence.chars().count() <= 80 {
            return sentence;
        }
        let prefix = sentence.chars().take(79).collect::<String>();
        let boundary = prefix.rfind(' ').filter(|i| *i > 0).unwrap_or(prefix.len());
        let short = balanced(&prefix[..boundary]);
        return format!("{}…", if short.is_empty() { "Task" } else { &short });
    }
    "Task".into()
}
