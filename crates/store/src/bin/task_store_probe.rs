//! Disposable cross-runtime adapter driver; never accepts an unmarked home.
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
        "read" => store
            .read(&args.next().ok_or("task id required")?)?
            .unwrap_or(Value::Null),
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
                match store.update(
                    &id,
                    rev,
                    current["createdAt"].as_f64().ok_or("missing time")?,
                    |v| {
                        let count = v["title"]
                            .as_str()
                            .unwrap_or("0")
                            .parse::<i64>()
                            .unwrap_or(0)
                            + 1;
                        v["title"] = json!(count.to_string());
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
            updated.ok_or("too many revision conflicts")?
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
        "restore" => {
            let id = args.next().ok_or("task id required")?;
            let now = args.next().ok_or("time required")?.parse::<f64>()?;
            store.restore(&id, now)?
        }
        _ => return Err("unknown command".into()),
    };
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
