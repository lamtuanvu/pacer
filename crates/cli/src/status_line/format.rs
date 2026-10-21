pub fn meter_text(used: Option<f64>, pace: Option<f64>, style: &str) -> String {
    let Some(used) = used else {
        return "usage unknown".into();
    };
    let u = js_round(used);
    let p = pace.map(js_round);
    match (style, p) {
        ("compact", Some(p)) => format!("{u}%·{p}"),
        ("compact", None) => format!("{u}%"),
        (_, Some(p)) => format!("{u}% used · pace {p}%"),
        (_, None) => format!("{u}% used"),
    }
}
pub fn js_round(n: f64) -> String {
    let n = (n + 0.5).floor();
    if n == 0.0 { "0".into() } else { n.to_string() }
}
pub fn back_in(at: Option<f64>, now: f64) -> String {
    at.map_or_else(
        || "reset unknown".into(),
        |at| format!("back in {}", duration(at - now)),
    )
}
pub fn duration(seconds: f64) -> String {
    let minutes = (seconds / 60.0).floor().max(0.0) as u64;
    let hours = minutes / 60;
    let days = hours / 24;
    if days > 0 {
        format!("{days}d {}h", hours % 24)
    } else if hours > 0 {
        format!("{hours}h {}m", minutes % 60)
    } else {
        format!("{minutes}m")
    }
}
