//! Finite title-only regex results, including syntax errors. Arbitrary patterns
//! bypass these statics; public JS regex compilation keeps its existing contract.
use regex::{Error, Regex};
use std::{borrow::Cow, sync::LazyLock};

type RegexResult = Result<Cow<'static, Regex>, Cow<'static, Error>>;

macro_rules! cached {
    ($compile:path, $pattern:literal) => {{
        static RESULT: LazyLock<Result<Regex, Error>> = LazyLock::new(|| $compile($pattern));
        RESULT.as_ref().map(Cow::Borrowed).map_err(Cow::Borrowed)
    }};
}

pub(super) fn js_regex(pattern: &str) -> RegexResult {
    match pattern {
        r"```[^\n]*\n[\s\S]*?(?:```|$)" => {
            cached!(crate::js::regex, r"```[^\n]*\n[\s\S]*?(?:```|$)")
        }
        r"[.!?](?:\s|$)" => cached!(crate::js::regex, r"[.!?](?:\s|$)"),
        r"!?\[([^\]]+)\]\[[^\]]*\]" => cached!(crate::js::regex, r"!?\[([^\]]+)\]\[[^\]]*\]"),
        r"^[\t \r]*(?:(?:#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+))+" => cached!(
            crate::js::regex,
            r"^[\t \r]*(?:(?:#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+))+"
        ),
        r"[`*~]" => cached!(crate::js::regex, r"[`*~]"),
        r"\s+#+\s*$" => cached!(crate::js::regex, r"\s+#+\s*$"),
        r"\s+" => cached!(crate::js::regex, r"\s+"),
        r"^[\s\p{P}>+=~|]+" => cached!(crate::js::regex, r"^[\s\p{P}>+=~|]+"),
        r"^(?:/|\.{1,2}/|~|[A-Za-z]:[\\/])" => {
            cached!(crate::js::regex, r"^(?:/|\.{1,2}/|~|[A-Za-z]:[\\/])")
        }
        r"\.[A-Za-z0-9]{1,10}$" => cached!(crate::js::regex, r"\.[A-Za-z0-9]{1,10}$"),
        r"```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)" => {
            cached!(crate::js::regex, r"```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)")
        }
        r"(?i)(?:https?://|www\.)[^\s<>]+" => {
            cached!(crate::js::regex, r"(?i)(?:https?://|www\.)[^\s<>]+")
        }
        r"[.!?;:,]+$" => cached!(crate::js::regex, r"[.!?;:,]+$"),
        r"^\s*#{1,6}\s*" => cached!(crate::js::regex, r"^\s*#{1,6}\s*"),
        r"(?i)^\s*(?:goal|task|summary|context)\s*(?::\s*|$)" => cached!(
            crate::js::regex,
            r"(?i)^\s*(?:goal|task|summary|context)\s*(?::\s*|$)"
        ),
        r"[\s<>]+" => cached!(crate::js::regex, r"[\s<>]+"),
        r#"^[([{"']+|[)\]}"',;:!?]+$"# => cached!(crate::js::regex, r#"^[([{"']+|[)\]}"',;:!?]+$"#),
        r"\.+$" => cached!(crate::js::regex, r"\.+$"),
        r"\.[^.]*$" => cached!(crate::js::regex, r"\.[^.]*$"),
        r"[.!?;:,](?:\s|$)" => cached!(crate::js::regex, r"[.!?;:,](?:\s|$)"),
        r"(?i)(?:\s+(?:in|on|at|to|for|from|of|and|or|with|into|under|via|by|the|a|an))+\s*$" => {
            cached!(
                crate::js::regex,
                r"(?i)(?:\s+(?:in|on|at|to|for|from|of|and|or|with|into|under|via|by|the|a|an))+\s*$"
            )
        }
        r"[.!?;:,](?:\s|$)|\s[—–]\s" => cached!(crate::js::regex, r"[.!?;:,](?:\s|$)|\s[—–]\s"),
        _ => crate::js::regex(pattern)
            .map(Cow::Owned)
            .map_err(Cow::Owned),
    }
}

pub(super) fn raw_regex(pattern: &str) -> RegexResult {
    match pattern {
        r"!?\[([^\]]+)\]\(" => cached!(Regex::new, r"!?\[([^\]]+)\]\("),
        r#"(^|[\s("'`])((?:[A-Za-z]:[\\/]|~?/)[^\s<>`]+)"# => cached!(
            Regex::new,
            r#"(^|[\s("'`])((?:[A-Za-z]:[\\/]|~?/)[^\s<>`]+)"#
        ),
        _ => Regex::new(pattern).map(Cow::Owned).map_err(Cow::Owned),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn each_initializer_runs_once_even_for_errors_under_contention() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static OK_CALLS: AtomicUsize = AtomicUsize::new(0);
        static ERROR_CALLS: AtomicUsize = AtomicUsize::new(0);
        fn compile_ok(pattern: &str) -> Result<Regex, Error> {
            OK_CALLS.fetch_add(1, Ordering::SeqCst);
            crate::js::regex(pattern)
        }
        fn compile_error(pattern: &str) -> Result<Regex, Error> {
            ERROR_CALLS.fetch_add(1, Ordering::SeqCst);
            crate::js::regex(pattern)
        }
        fn first_ok() -> RegexResult {
            cached!(compile_ok, r"\s+")
        }
        fn first_error() -> RegexResult {
            cached!(compile_error, "[")
        }
        let barrier = std::sync::Barrier::new(16);
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..8 {
                        let re = first_ok().unwrap();
                        assert!(matches!(re, Cow::Borrowed(_)));
                        assert!(re.is_match("\u{feff}"));
                        assert!(matches!(first_error(), Err(Cow::Borrowed(_))));
                    }
                });
            }
        });
        assert_eq!(OK_CALLS.load(Ordering::SeqCst), 1);
        assert_eq!(ERROR_CALLS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn simultaneous_first_use_preserves_matches_and_errors() {
        let barrier = std::sync::Barrier::new(16);
        std::thread::scope(|scope| {
            for _ in 0..16 {
                scope.spawn(|| {
                    barrier.wait();
                    for _ in 0..8 {
                        let re = js_regex(r"\s+").unwrap();
                        assert!(matches!(re, Cow::Borrowed(_)));
                        assert_eq!(re.replace_all("a\u{feff}b", "-"), "a-b");
                        assert!(re.is_match("\u{feff}"));
                        assert!(!re.is_match("\u{85}"));
                        let raw = raw_regex(r"!?\[([^\]]+)\]\(").unwrap();
                        assert!(matches!(raw, Cow::Borrowed(_)));
                        assert_eq!(&raw.captures("[é](url)").unwrap()[1], "é");
                        let bad = r#"^[([{"']+|[)\]}"',;:!?]+$"#;
                        assert!(matches!(js_regex(bad), Err(Cow::Borrowed(_))));
                        assert_eq!(
                            js_regex(bad).unwrap_err().to_string(),
                            crate::js::regex(bad).unwrap_err().to_string()
                        );
                    }
                });
            }
        });
    }

    #[test]
    fn arbitrary_patterns_keep_public_helper_semantics() {
        for pattern in ["", "[", r"(?i)arbitrary\s+pattern", r"(a)(b)"] {
            let expected = crate::js::regex(pattern);
            let actual = js_regex(pattern);
            assert!(matches!(actual, Ok(Cow::Owned(_)) | Err(Cow::Owned(_))));
            assert!(matches!(
                raw_regex(pattern),
                Ok(Cow::Owned(_)) | Err(Cow::Owned(_))
            ));
            assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
            if let Ok(re) = actual {
                assert_eq!(
                    re.replace_all("ab arbitrary\u{feff}pattern", "$2$1"),
                    expected
                        .unwrap()
                        .replace_all("ab arbitrary\u{feff}pattern", "$2$1")
                );
            }
        }
    }
}
