//! Cross-runtime driver for `record_review_verdict`; opens only the given PACER_HOME.
use pacer_lifecycle::record_review_verdict;
use pacer_store::TaskStore;
use std::{env, error::Error, path::PathBuf};

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let pacer_home = PathBuf::from(args.next().ok_or("pacer_home required")?);
    let id = args.next().ok_or("id required")?;
    let accepted = args.next().ok_or("verdict required")? == "accept";
    let kind = args.next().ok_or("kind slot required")?;
    let kind = if kind.is_empty() { None } else { Some(kind.as_str()) };
    let note = args.next().ok_or("note slot required")?;
    let note = if note.is_empty() { None } else { Some(note.as_str()) };
    let expect = args.next().ok_or("expect_rev slot required")?;
    let expect_rev = if expect.is_empty() {
        None
    } else {
        Some(expect.parse::<f64>()?)
    };
    let now = args
        .next()
        .ok_or("now required")?
        .parse::<f64>()?;
    let mut store = TaskStore::open(&pacer_home)?;
    let task = record_review_verdict(
        &mut store,
        &id,
        accepted,
        kind,
        note,
        expect_rev,
        now,
    )?;
    println!("{}", serde_json::to_string(&task)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
