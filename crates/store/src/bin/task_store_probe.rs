//! Disposable cross-runtime adapter driver; never accepts an unmarked home.
use pacer_js_json::WireReply;
use pacer_store::{StoreError, TaskFilter, TaskStore};
use serde_json::{Value, json};
use std::{env, error::Error, path::PathBuf};

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("command required")?;
    let home = PathBuf::from(args.next().ok_or("disposable home required")?);
    if !home.join(".sqlite-proof-home").is_file() {
        return Err("home lacks disposable proof marker".into());
    }
    let mut store = TaskStore::open(home)?;
    let value: Value = match command.as_str() {
        "read" => {
            let value = match store.read_wire(&args.next().ok_or("task id required")?)? {
                Some(mut value) => {
                    if value.preview().get("rev").is_none_or(Value::is_null) {
                        value.put("/rev", WireReply::new(json!(1)))?;
                    }
                    value
                }
                None => WireReply::new(Value::Null),
            };
            return emit_wire(value);
        }
        // These pre-existing list commands still deliver scalar previews.
        // They are not exact sources for subsequent task edits.
        "list" => json!(store.list(&TaskFilter::default())?),
        "list-live" => json!(store.list_live()?),
        "list-recent" => {
            let since = args
                .next()
                .ok_or("updated since required")?
                .parse::<f64>()?;
            json!(store.list_active_and_recent(since)?)
        }
        "version" => json!(store.version()?),
        "increment" => {
            let id = args.next().ok_or("task id required")?;
            let mut updated = None;
            for _ in 0..20 {
                let current = store.read(&id)?.ok_or("unknown task")?;
                let rev = current["rev"].as_i64().ok_or("missing revision")?;
                match store.edit(
                    &id,
                    rev,
                    current["createdAt"].as_f64().ok_or("missing time")?,
                    |edit| {
                        let count = edit.preview()["title"]
                            .as_str()
                            .unwrap_or("0")
                            .parse::<i64>()
                            .unwrap_or(0)
                            + 1;
                        edit.put("/title", WireReply::new(json!(count.to_string())))
                    },
                ) {
                    Ok(value) => {
                        updated = Some(value);
                        break;
                    }
                    Err(StoreError::Conflict) => std::thread::yield_now(),
                    Err(error) => return Err(error.into()),
                }
            }
            return emit_wire(updated.ok_or("too many revision conflicts")?);
        }
        "prune" => {
            let now = args.next().ok_or("time required")?.parse::<f64>()?;
            json!(
                store
                    .prune(1, false, now)?
                    .tasks
                    .into_iter()
                    .map(|t| t.id)
                    .collect::<Vec<_>>()
            )
        }
        "prune-result" | "prune-dry" => {
            let now = args.next().ok_or("time required")?.parse::<f64>()?;
            let result = store.prune(1, command == "prune-dry", now)?;
            json!({
                "bytesSaved": result.bytes_saved,
                "workingSetBytes": result.working_set_bytes,
                "tasks": result.tasks.into_iter().map(|t| json!({
                    "id": t.id, "bytes": t.bytes, "bytesSaved": t.bytes_saved, "files": t.files
                })).collect::<Vec<_>>()
            })
        }
        "restore" => {
            let id = args.next().ok_or("task id required")?;
            let now = args.next().ok_or("time required")?.parse::<f64>()?;
            return emit_wire(store.restore(&id, now)?);
        }
        _ => return Err("unknown command".into()),
    };
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}
fn emit_wire(value: WireReply) -> Result<(), Box<dyn Error>> {
    println!("{}", value.to_json()?);
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
