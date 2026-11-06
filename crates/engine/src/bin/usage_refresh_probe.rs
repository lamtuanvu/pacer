//! Cross-runtime driver for `usage_refresh` capability/outcome rules.
use pacer_engine::usage_refresh::{
    automatic_refresh_suppressed, refresh_capability, refresh_outcome,
};
use serde_json::Value;
use std::{env, error::Error};

fn parse_json(raw: &str) -> Result<Value, Box<dyn Error>> {
    Ok(serde_json::from_str(raw)?)
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mode = args.next().ok_or("mode required")?;
    match mode.as_str() {
        "capability" => {
            let account = parse_json(&args.next().ok_or("account json required")?)?;
            println!("{}", refresh_capability(&account));
        }
        "outcome" => {
            let capability = args.next().ok_or("capability required")?;
            let prior = parse_json(&args.next().ok_or("prior json required")?)?;
            let current = parse_json(&args.next().ok_or("current json required")?)?;
            println!("{}", refresh_outcome(&capability, &prior, &current));
        }
        "automatic" => {
            let now: f64 = args.next().ok_or("now required")?.parse()?;
            let last = args.next().ok_or("last slot required")?;
            let last_at = if last.is_empty() {
                None
            } else {
                Some(last.parse::<f64>()?)
            };
            let automatic = args.next().ok_or("automatic required")? == "1";
            println!("{}", automatic_refresh_suppressed(now, last_at, automatic));
        }
        _ => return Err(format!("unknown mode {mode}").into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
