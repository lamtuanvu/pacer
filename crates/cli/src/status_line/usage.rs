//! Compact usageView figure words for the status line (ADR 0030). Copied from
//! `src/view-model/usage.ts` figureWords — CRATE-4 keeps the CLI free of domain crates.
use serde_json::Value;

fn js_round(n: f64) -> f64 {
    let base = n.floor();
    if n - base < 0.5 { base } else { base + 1. }
}

/// (`figure`, `meter`) matching TypeScript `figureWords`.
pub fn figure_words(state: Option<&Value>) -> (String, Option<f64>) {
    let Some(state) = state.filter(|s| !s.is_null()) else {
        return ("Usage unknown".into(), None);
    };
    if !state["limit"].is_null() {
        let meter = state["figure"]["usedPct"]
            .as_f64()
            .map(js_round)
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
    let pct = js_round(state["figure"]["usedPct"].as_f64().unwrap_or(0.0));
    (format!("{pct}%"), Some(pct))
}
