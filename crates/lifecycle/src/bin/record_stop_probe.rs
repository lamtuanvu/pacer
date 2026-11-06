//! Cross-runtime driver for `record_task_stop`; opens only the given PACER_HOME.
use pacer_lifecycle::record_task_stop;
use pacer_store::TaskStore;
use std::{env, error::Error, path::PathBuf};

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let pacer_home = PathBuf::from(args.next().ok_or("pacer_home required")?);
    let id = args.next().ok_or("id required")?;
    let expect = args.next().ok_or("expect_rev slot required")?;
    let expect_rev = if expect.is_empty() {
        None
    } else {
        Some(expect.parse::<f64>()?)
    };
    let now = args.next().ok_or("now required")?.parse::<f64>()?;
    let runner_alive = args.next().ok_or("runner_alive required")? == "1";
    let mut store = TaskStore::open(&pacer_home)?;
    let task = record_task_stop(&mut store, &id, expect_rev, now, runner_alive)?;
    println!("{}", serde_json::to_string(&task)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
