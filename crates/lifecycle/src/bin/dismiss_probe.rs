//! Cross-runtime driver for `dismiss_tasks`; opens only the given PACER_HOME.
use pacer_lifecycle::dismiss_tasks;
use pacer_store::TaskStore;
use serde_json::json;
use std::{env, io::Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let home = args.next().ok_or("home required")?;
    let ids_json = args.next().ok_or("ids json required")?;
    let expect = args
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<f64>())
        .transpose()
        .map_err(|e| e.to_string())?;
    let now = args.next().ok_or("now required")?.parse::<f64>()?;
    let ids: Vec<String> = serde_json::from_str(&ids_json)?;
    let mut store = TaskStore::open(home)?;
    let batch = dismiss_tasks(&mut store, &ids, expect, now)?;
    let dismissed: Vec<String> = batch
        .dismissed
        .iter()
        .filter_map(|t| t.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    let out = json!({"dismissed": dismissed, "unknown": batch.unknown});
    std::io::stdout().write_all(out.to_string().as_bytes())?;
    Ok(())
}
