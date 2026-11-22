//! Compact usageView figure words for the status line (ADR 0030). Copied from
//! `src/view-model/usage.ts` figureWords — CRATE-4 keeps the CLI free of domain crates.
use serde_json::Value;

use super::format::js_round;

/// (`figure`, `meter`) matching TypeScript `figureWords`.
pub fn figure_words(state: Option<&Value>) -> (String, Option<f64>) {
    let Some(state) = state.filter(|s| !s.is_null()) else {
        return ("Usage unknown".into(), None);
    };
    if !state["limit"].is_null() {
        let meter = state["figure"]["usedPct"]
            .as_f64()
            .map(|n| js_round(n).parse::<f64>().unwrap_or(0.0))
            .unwrap_or(100.0);
        return ("Out of quota".into(), Some(meter));
    }
    if state["figure"].is_null() {
        let figure = if state["verdict"].as_str() == Some("UNMETERED") {
            "Unmetered"
        } else {
            "No usage figure"
        };
        return (figure.into(), None);
    }
    let pct = js_round(state["figure"]["usedPct"].as_f64().unwrap_or(0.0))
        .parse::<f64>()
        .unwrap_or(0.0);
    (format!("{pct}%"), Some(pct))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn figure_words_unknown_without_record() {
        assert_eq!(figure_words(None), ("Usage unknown".into(), None));
        assert_eq!(
            figure_words(Some(&Value::Null)),
            ("Usage unknown".into(), None)
        );
    }

    #[test]
    fn figure_words_limit_and_metered() {
        assert_eq!(
            figure_words(Some(
                &json!({"limit":{"kind":"quota"},"figure":{"usedPct":99.4}})
            )),
            ("Out of quota".into(), Some(99.0))
        );
        assert_eq!(
            figure_words(Some(
                &json!({"limit":null,"figure":{"usedPct":63.6},"verdict":"BEHIND"})
            )),
            ("64%".into(), Some(64.0))
        );
    }

    #[test]
    fn figure_words_missing_figure() {
        assert_eq!(
            figure_words(Some(
                &json!({"limit":null,"figure":null,"verdict":"UNMETERED"})
            )),
            ("Unmetered".into(), None)
        );
        assert_eq!(
            figure_words(Some(
                &json!({"limit":null,"figure":null,"verdict":"BEHIND"})
            )),
            ("No usage figure".into(), None)
        );
    }
}
