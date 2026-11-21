//! Copy of `src/view-model/usage.ts` (ADR 0030 decision 7). CRATE-4: no runtime
//! domain crate deps; the words stay pinned by tests against the TypeScript fixtures.
use crate::model::{ago, js_round, num, number, text};
use crate::words::pace_status;
use chrono::{DateTime, Datelike, Utc};
use serde_json::Value as V;

#[derive(Clone, Debug, PartialEq)]
pub struct UsageView {
    pub figure: String,
    pub meter: Option<f64>,
    pub window: String,
    pub reset: String,
    pub freshness: String,
    pub tone: &'static str,
    pub verdict_label: String,
    pub summary: String,
    pub summary_used: String,
}

pub fn window_words(window: &str) -> String {
    let name = window.to_ascii_lowercase();
    match name.as_str() {
        "weekly" | "week" | "7d" => "week".into(),
        "monthly" | "month" => "month".into(),
        "daily" | "day" => "day".into(),
        "5h" => "5 h".into(),
        _ => window.into(),
    }
}

fn age_words(seconds: f64) -> String {
    let s = seconds.floor().max(0.);
    if s < 60. {
        format!("{}s", number(s))
    } else if s < 3600. {
        format!("{}m", number((s / 60.).floor()))
    } else if s < 7. * 86400. {
        format!("{}h", number((s / 3600.).floor()))
    } else {
        format!("{}d", number((s / 86400.).floor()))
    }
}

/// Calendar pieces for a timestamp (UTC, matching the dashboard's fixed UTC theme).
fn clock_parts(at: f64, now: f64) -> Option<(i64, String, String, String)> {
    let d = DateTime::<Utc>::from_timestamp_millis((at * 1000.).trunc() as i64)?;
    let n = DateTime::<Utc>::from_timestamp_millis((now * 1000.).trunc() as i64)?;
    let days = (n.date_naive() - d.date_naive()).num_days();
    let time = d.format("%H:%M").to_string();
    let weekday = d.format("%a").to_string();
    let date = if d.year() == n.year() {
        d.format("%-d %b").to_string()
    } else {
        d.format("%-d %b %Y").to_string()
    };
    Some((days, time, weekday, date))
}

pub fn reset_words(resets_at: Option<f64>, now: f64) -> String {
    let Some(resets_at) = resets_at else {
        return "reset unknown".into();
    };
    if resets_at <= now {
        return "reset due".into();
    }
    let Some((days, time, weekday, date)) = clock_parts(resets_at, now) else {
        return "reset unknown".into();
    };
    if days == 0 {
        format!("resets {time}")
    } else if -days < 7 {
        format!("resets {weekday} {time}")
    } else {
        format!("resets {date}")
    }
}

pub fn freshness_words(state: &V, now: f64) -> String {
    match text(&state["freshness"]) {
        "fresh" => {
            if state["observedAt"].is_null() {
                String::new()
            } else {
                format!("Updated {}", ago(num(&state["observedAt"]), now))
            }
        }
        "historical" => {
            if state["observedAt"].is_null() {
                "Reading of unknown age · refresh".into()
            } else {
                format!(
                    "Reading {} old · refresh",
                    age_words(now - num(&state["observedAt"]))
                )
            }
        }
        _ => String::new(),
    }
}

pub fn figure_words(state: Option<&V>) -> (String, Option<f64>) {
    let Some(state) = state.filter(|s| !s.is_null()) else {
        return ("Usage unknown".into(), None);
    };
    if truth_limit(state) {
        let meter = state["figure"]["usedPct"]
            .as_f64()
            .map(round_pct)
            .unwrap_or(100.);
        return ("Out of quota".into(), Some(meter));
    }
    if state["figure"].is_null() {
        let figure = if text(&state["verdict"]) == "UNMETERED" {
            "Unmetered"
        } else {
            "No usage figure"
        };
        return (figure.into(), None);
    }
    let pct = round_pct(num(&state["figure"]["usedPct"]));
    (format!("{}%", number(pct)), Some(pct))
}

fn truth_limit(state: &V) -> bool {
    !state["limit"].is_null()
}

fn round_pct(n: f64) -> f64 {
    // Match Math.round via the dashboard's js_round helper.
    js_round(n)
}

pub fn caption_reset(reset: &str) -> Option<&str> {
    if reset.is_empty() || reset == "reset unknown" {
        None
    } else {
        Some(reset)
    }
}

/// One usage view over the service's usageState JSON; every surface renders exactly this.
pub fn usage_view(state: Option<&V>, now: f64) -> UsageView {
    let (figure, meter) = figure_words(state);
    let window = match state {
        Some(s) if truth_limit(s) => {
            let w = text(&s["figure"]["window"]);
            window_words(if w.is_empty() { "limit" } else { w })
        }
        Some(s) => window_words(text(&s["figure"]["window"])),
        None => String::new(),
    };
    let reset = match state {
        Some(s) if !s["figure"].is_null() => reset_words(s["figure"]["resetsAt"].as_f64(), now),
        _ => String::new(),
    };
    let freshness = state.map(|s| freshness_words(s, now)).unwrap_or_default();
    let tone = match state {
        Some(s) => pace_status(text(&s["verdict"])).tone,
        None => "neutral",
    };
    let verdict_label = match state {
        Some(s) => pace_status(text(&s["verdict"])).label.to_string(),
        None => "Usage unknown".into(),
    };
    let metered = figure.ends_with('%');
    let summary = if metered && !window.is_empty() {
        format!("{figure} of {window}")
    } else {
        figure.clone()
    };
    let summary_used = if metered {
        if window.is_empty() {
            format!("{figure} used")
        } else {
            format!("{figure} of {window} used")
        }
    } else {
        figure.clone()
    };
    UsageView {
        figure,
        meter,
        window,
        reset,
        freshness,
        tone,
        verdict_label,
        summary,
        summary_used,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(over: serde_json::Value) -> V {
        let mut base = json!({
            "scope": {"account": "claude"},
            "source": "provider-cli",
            "figure": {"usedPct": 68.4, "window": "weekly", "lengthS": 604800, "resetsAt": null},
            "windows": [],
            "limit": null,
            "blockedRunners": [],
            "observedAt": 0.,
            "freshness": "fresh",
            "verdict": "ON_PACE",
        });
        if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
            for (k, v) in o {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    }

    #[test]
    fn figure_words_match_the_spec() {
        assert_eq!(figure_words(None).0, "Usage unknown");
        assert_eq!(
            figure_words(Some(&state(json!({"limit": {"until": 1}})))).0,
            "Out of quota"
        );
        assert_eq!(
            figure_words(Some(&state(json!({"figure": null, "verdict": "OK"})))).0,
            "No usage figure"
        );
        assert_eq!(
            figure_words(Some(&state(
                json!({"figure": null, "verdict": "UNMETERED"})
            )))
            .0,
            "Unmetered"
        );
        let (figure, meter) = figure_words(Some(&state(json!({}))));
        assert_eq!(figure, "68%");
        assert_eq!(meter, Some(68.));
    }

    #[test]
    fn window_and_freshness_words() {
        assert_eq!(window_words("weekly"), "week");
        assert_eq!(window_words("5h"), "5 h");
        let now = 1_800_000_000_f64;
        let fresh_at = now - 180.0;
        let hist_at = now - 26.0 * 3600.0;
        assert_eq!(
            freshness_words(
                &state(json!({"freshness":"fresh","observedAt": fresh_at})),
                now
            ),
            "Updated 3m ago"
        );
        assert_eq!(
            freshness_words(
                &state(json!({"freshness":"historical","observedAt": hist_at})),
                now
            ),
            "Reading 26h old · refresh"
        );
        assert_eq!(
            freshness_words(
                &state(json!({"freshness":"historical","observedAt": null})),
                now
            ),
            "Reading of unknown age · refresh"
        );
    }
}
