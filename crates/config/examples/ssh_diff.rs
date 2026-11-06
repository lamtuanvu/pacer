//! JSON-lines adapter for TypeScript/Rust SSH config parity tests.
use pacer_config::ssh_config::{ssh_suggestions, suggest_hosts};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let input: Value = serde_json::from_str(&line)?;
        let home = PathBuf::from(input["home"].as_str().unwrap_or(""));
        let output = match input["op"].as_str().unwrap_or("") {
            "aliases" => {
                let names: Vec<_> = ssh_suggestions(&home).into_iter().map(|a| a.name).collect();
                json!({"names": names})
            }
            "suggestions" => {
                let used: Vec<&str> = input["used"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                json!({"result": suggest_hosts(&home, &used, input["details"] == true)})
            }
            "detail" => {
                let got: Vec<_> = ssh_suggestions(&home)
                    .into_iter()
                    .map(|a| json!({"name": a.name, "host": a.host}))
                    .collect();
                json!({"rows": got})
            }
            _ => json!({"error": "unknown op"}),
        };
        println!("{output}");
    }
    Ok(())
}
