//! Untrusted issue text as plain text: `cleanLine` and `cleanBody` from `src/core/issue-import.ts`.
use pacer_foundation::js_semantics::js_trim;
use regex::Regex;
use std::sync::LazyLock;

type Pattern = LazyLock<Option<Regex>>;

// Controls (except tab and newline), format characters (bidi overrides, zero-width characters, tag
// characters, U+061C, U+FEFF), variation selectors and invisible fillers. Rust strings hold no lone
// surrogates, so the TypeScript `\p{Cs}` class has nothing to remove here.
static CONTROL: Pattern = LazyLock::new(|| {
    Regex::new(r"[[\p{Cc}\p{Cf}\x{115f}\x{1160}\x{3164}\x{ffa0}\x{fe00}-\x{fe0f}\x{e0100}-\x{e01ef}]--[\n\t]]").ok()
});
static LINE_BREAKS: Pattern = LazyLock::new(|| Regex::new(r"[\r\n\t\x{2028}\x{2029}]+").ok());
static NEWLINES: Pattern = LazyLock::new(|| Regex::new(r"\r\n?|[\x{2028}\x{2029}]").ok());
// Markdown that a rendered preview does not show: HTML comments (an unterminated one hides the
// rest of the text) and link reference definitions other than footnotes.
static COMMENT: Pattern = LazyLock::new(|| Regex::new(r"(?s)<!--.*?(?:-->|\z)").ok());
static LINK_REFERENCE: Pattern =
    LazyLock::new(|| Regex::new(r"(?m)^ {0,3}\[[^\]\n^][^\]\n]*\]:[^\n]*(?:\n|$)").ok());

fn replace(pattern: &Pattern, text: &str, with: &str) -> String {
    match pattern.as_ref() {
        Some(re) => re.replace_all(text, with).into_owned(),
        None => text.to_owned(),
    }
}

pub(crate) fn strip_controls(value: &str) -> String {
    replace(&CONTROL, value, "")
}

/// Plain text with controls removed, cut to `max` code points.
pub(crate) fn clean_line(value: &str, max: usize) -> (String, bool) {
    let stripped = strip_controls(&replace(&LINE_BREAKS, value, " "));
    let trimmed = js_trim(&stripped);
    (
        trimmed.chars().take(max).collect(),
        trimmed.chars().count() > max,
    )
}

/// Multi-line plain text with controls and hidden Markdown removed and CRLF normalised, cut to
/// `max_bytes` of UTF-8 on a code point boundary.
pub(crate) fn clean_body(value: &str, max_bytes: usize) -> (String, bool) {
    let text = strip_controls(&replace(&NEWLINES, value, "\n"));
    let mut text = replace(&LINK_REFERENCE, &replace(&COMMENT, &text, ""), "");
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = 0;
    for (at, ch) in text.char_indices() {
        if at + ch.len_utf8() > max_bytes {
            break;
        }
        end = at + ch.len_utf8();
    }
    text.truncate(end);
    (text, true)
}

#[cfg(test)]
pub(crate) fn patterns_compile() -> bool {
    [&CONTROL, &LINE_BREAKS, &NEWLINES, &COMMENT, &LINK_REFERENCE]
        .iter()
        .all(|p| p.is_some())
}
