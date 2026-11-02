//! Disposable admission contention driver; never opens an unmarked home.
use pacer_lifecycle::{AdmissionState, DrainRoute};
use serde_json::{Value, json};
use std::{env, error::Error, path::PathBuf};
fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("command required")?;
    let home = PathBuf::from(args.next().ok_or("disposable home required")?);
    if !home.join(".sqlite-proof-home").is_file() {
        return Err("home lacks disposable proof marker".into());
    }
    let mut state = AdmissionState::open(&home)?;
    let value = match command.as_str() {
        "read" => state
            .read(&args.next().ok_or("id required")?)?
            .unwrap_or(Value::Null),
        "work" => state
            .work(&args.next().ok_or("id required")?)?
            .unwrap_or(Value::Null),
        "register" => {
            let id = args.next().ok_or("id required")?;
            let parent = args.next();
            state.register(&id, &json!({}), parent.as_deref(), 1.0)?
        }
        "drain" => json!(state.drain(
            2.0,
            false,
            |_| Ok(vec![DrainRoute::local("codex", 1)]),
            |_| Ok(None)
        )?),
        "review" => {
            let id = args.next().ok_or("id required")?;
            let rev = args.next().ok_or("revision required")?.parse::<f64>()?;
            let accepted = args.next().ok_or("verdict required")? == "accept";
            let ready = args.next().ok_or("ready path required")?;
            let release = args.next().ok_or("release path required")?;
            std::fs::write(ready, "ready")?;
            let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !std::path::Path::new(&release).is_file() && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            if !std::path::Path::new(&release).is_file() {
                return Err("review release timed out".into());
            }
            match state.mutate(&id,rev,1.0,|_,task|{
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let label=json!({"ts":1,"type":"task_review","task_id":id,"accepted":accepted,"kind":task["kind"],"note":null,"executor":task["result"]["executor"]});
                let mut labels=std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(home.join("labels.jsonl"))?;
                writeln!(labels,"{label}")?;
                task["review"]=json!({"accepted":accepted,"kind":task["kind"],"note":null,"at":1});task["resolved"]=json!("reviewed");Ok(())
            }) {
                Ok(_)=>json!({"ok":true}),
                Err(pacer_lifecycle::MutationError::Conflict {task})=>json!({"code":"conflict","rev":task["rev"]}),
                Err(error)=>return Err(error.into()),
            }
        }
        "child" => {
            let parent = args.next().ok_or("parent required")?;
            let id = args.next().ok_or("id required")?;
            let task = json!({"id":id,"rev":1,"brief":{"goal":"child","repo":home},"kind":null,"requestedExecutor":null,"state":"queued","createdAt":1,"attempts":[],"timeoutS":60});
            match state.create(&task, Some(&json!({})), Some(&parent), 1.0) {
                Ok(()) => json!({"ok":true}),
                Err(e) => json!({"error":e.to_string()}),
            }
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
