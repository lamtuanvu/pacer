//! Cross-runtime driver for prepared delegate admission (identity policy only).
use pacer_lifecycle::{
    DelegateAdmissionSnapshot, PolicyAmendment, map_policy_amendment, prepare_delegate_admission,
};
use serde_json::{Value, json};
use std::{env, error::Error, fs, path::PathBuf};

fn snapshot(strategy: &Value) -> DelegateAdmissionSnapshot {
    DelegateAdmissionSnapshot {
        strategy: strategy.clone(),
        projects: json!({"version":1,"projects":{}}),
        repo: Value::Null,
        exclusions: json!({}),
        registered: None,
        parent: None,
        work: None,
        root: None,
        active: None,
        candidates: None,
        context: None,
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("command required")?;
    match command.as_str() {
        "map" => {
            let input = serde_json::from_str::<Value>(&args.next().ok_or("input json")?)?;
            let amend = serde_json::from_str::<Value>(&args.next().ok_or("amend json")?)?;
            let mapped = map_policy_amendment(&input, &PolicyAmendment::from_value(&amend));
            println!("{}", serde_json::to_string(&mapped)?);
        }
        "prepare" => {
            let repo = PathBuf::from(args.next().ok_or("repo path")?);
            if !repo.is_dir() {
                return Err("repo must be an existing directory".into());
            }
            let brief = serde_json::from_str::<Value>(&args.next().ok_or("brief json")?)?;
            let strategy = serde_json::from_str::<Value>(&args.next().ok_or("strategy json")?)?;
            let mut brief = brief;
            if let Some(r) = brief.get("repo").and_then(Value::as_str)
                && r == "$REPO"
            {
                brief["repo"] = json!(repo);
            }
            let mut raw = json!({ "goal": brief["goal"], "repo": brief["repo"] });
            if let Some(executor) = brief.get("executor").filter(|v| !v.is_null()) {
                raw["executor"] = executor.clone();
            }
            let strategy = strategy.clone();
            let receipt = prepare_delegate_admission(
                &raw,
                repo.to_str().ok_or("repo path")?,
                &[],
                None,
                || Ok(snapshot(&strategy)),
                |input| Ok(input.clone()),
            )?;
            println!("{}", serde_json::to_string(&receipt.input())?);
        }
        "prepare-file" => {
            let fixture = fs::read_to_string(args.next().ok_or("fixture path")?)?;
            let case: Value = serde_json::from_str(&fixture)?;
            let repo = std::env::temp_dir().join(format!(
                "pacer-prepared-admission-{}",
                std::process::id()
            ));
            fs::create_dir_all(&repo)?;
            let brief = case["brief"].clone();
            let strategy = case["strategy"].clone();
            let mut brief_obj = brief.clone();
            if brief_obj["repo"] == "$REPO" {
                brief_obj["repo"] = json!(repo);
            }
            let mut raw = json!({ "goal": brief_obj["goal"], "repo": brief_obj["repo"] });
            if let Some(executor) = brief_obj.get("executor").filter(|v| !v.is_null()) {
                raw["executor"] = executor.clone();
            }
            let strategy = strategy.clone();
            let result = prepare_delegate_admission(
                &raw,
                repo.to_str().unwrap(),
                &[],
                None,
                || Ok(snapshot(&strategy)),
                |input| Ok(input.clone()),
            );
            match (result, case["accept"].as_bool()) {
                (Ok(receipt), Some(true)) => {
                    println!("{}", serde_json::to_string(&json!({"ok":true,"input":receipt.input()}))?);
                }
                (Err(error), Some(false)) => {
                    println!(
                        "{}",
                        serde_json::to_string(&json!({"ok":false,"error":error.to_string()}))?
                    );
                }
                (Ok(_), Some(false)) => return Err("expected refusal".into()),
                (Err(_), Some(true)) => return Err("expected acceptance".into()),
                _ => return Err("fixture must include accept".into()),
            }
        }
        other => return Err(format!("unknown command: {other}").into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
