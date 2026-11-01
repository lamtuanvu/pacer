//! Disposable cross-runtime probe; not linked into the pacer host.
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    env,
    error::Error,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn open(home: &Path) -> Result<Connection> {
    let db = Connection::open(home.join("state/tasks.db"))?;
    db.busy_timeout(Duration::from_millis(5_000))?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(db)
}

fn snapshot(db: &Connection) -> Result<Value> {
    let mut schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")?;
    let schema: Vec<Value> = schema
        .query_map([], |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?
            ]))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut rows = db.prepare("SELECT id,rev,state,created_at,updated_at,settled_at,repo,record,json_mtime,archived FROM tasks ORDER BY id")?;
    let rows: Vec<Value> = rows.query_map([], |r| {
        let record: String = r.get(7)?;
        Ok(json!({"id":r.get::<_,String>(0)?,"rev":r.get::<_,i64>(1)?,"state":r.get::<_,String>(2)?,"created_at":r.get::<_,f64>(3)?,"updated_at":r.get::<_,f64>(4)?,"settled_at":r.get::<_,Option<f64>>(5)?,"repo":r.get::<_,Option<String>>(6)?,"record":serde_json::from_str::<Value>(&record).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,"json_mtime":r.get::<_,Option<f64>>(8)?,"archived":r.get::<_,i64>(9)?}))
    })?.collect::<std::result::Result<_, _>>()?;
    let has_table = |name: &str| -> rusqlite::Result<bool> {
        Ok(db
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                [name],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false))
    };
    let work_nodes = if has_table("work_nodes")? {
        let mut q =
            db.prepare("SELECT task_id,root_id,depth,options FROM work_nodes ORDER BY task_id")?;
        q.query_map([], |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?
            ]))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let messages = if has_table("messages")? {
        let mut q = db.prepare("SELECT id,root_id,body,status FROM messages ORDER BY id")?;
        q.query_map([], |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?
            ]))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    Ok(
        json!({"schema":schema,"tasks":rows,"work_nodes":work_nodes,"messages":messages,"sqlite_version":db.query_row("SELECT sqlite_version()", [], |r| r.get::<_,String>(0))?}),
    )
}

fn write_json(home: &Path, id: &str, record: &Value) -> Result<f64> {
    let dir = home.join("tasks");
    let target = dir.join(format!("{id}.json"));
    let temp = dir.join(format!("{id}.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| -> Result<()> {
        file.write_all(serde_json::to_string(record)?.as_bytes())?;
        drop(file);
        fs::rename(&temp, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    let mtime = fs::metadata(target)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?;
    Ok(mtime.as_secs() as f64 * 1_000.0 + f64::from(mtime.subsec_nanos()) / 1_000_000.0)
}

fn increment(home: &Path, id: &str, marked: bool) -> Result<Value> {
    if !id.starts_with("t-") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid task id".into());
    }
    let ctx = Ctx::with(
        home.to_path_buf(),
        home.to_path_buf(),
        Default::default(),
        0.0,
    );
    if marked {
        fs::write(home.join(".sqlite-proof-ready"), b"ready\n")?;
    }
    with_lock(
        &ctx,
        &format!("task-{id}"),
        LockOptions::default(),
        || -> Result<Value> {
            if marked {
                fs::write(home.join(".sqlite-proof-acquired"), b"acquired\n")?;
            }
            let mut db = open(home)?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let text: String = tx
                .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| r.get(0))
                .optional()?
                .ok_or("missing task")?;
            let mut record: Value = serde_json::from_str(&text)?;
            let rev = record["rev"].as_i64().ok_or("missing revision")? + 1;
            let count = record["title"].as_str().unwrap_or("0").parse::<i64>()? + 1;
            record["rev"] = json!(rev);
            record["title"] = json!(count.to_string());
            let mtime = write_json(home, id, &record)?;
            tx.execute(
                "UPDATE tasks SET rev=?,record=?,json_mtime=? WHERE id=?",
                params![rev, serde_json::to_string(&record)?, mtime, id],
            )?;
            tx.commit()?;
            Ok(record)
        },
    )?
}

fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("command required")?;
    let home = PathBuf::from(args.next().ok_or("disposable home required")?);
    if !home.join(".sqlite-proof-home").is_file() {
        return Err("home lacks disposable proof marker".into());
    }
    let output = match command.as_str() {
        "snapshot" => snapshot(&open(&home)?)?,
        "increment" | "increment-marked" => increment(
            &home,
            &args.next().ok_or("task id required")?,
            command == "increment-marked",
        )?,
        _ => return Err("unknown command".into()),
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
