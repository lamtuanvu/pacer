//! JSON-lines adapter for the seeded TypeScript differential test.
use pacer_config::{
    host::{HostEdit, edit_host, repo_key},
    strategy::validate_strategy,
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let input: Value = serde_json::from_str(&line)?;
        let output = if input["op"] == "validate" {
            json!({"valid":validate_strategy(&input["value"], Path::new("strategy.yaml"), "default").is_ok()})
        } else if input["op"] == "key" {
            json!({"key":repo_key(input["url"].as_str().unwrap_or(""))})
        } else {
            let alias = input["alias"].as_str().unwrap_or("");
            let edit = match input["op"].as_str().unwrap_or("") {
                "add" => HostEdit::Add {
                    alias,
                    ssh: input["ssh"].as_str().unwrap_or(""),
                },
                "remove" => HostEdit::Remove { alias },
                "map" => HostEdit::MapRepo {
                    alias,
                    key: input["key"].as_str().unwrap_or(""),
                    path: input["path"].as_str().unwrap_or(""),
                },
                "set" => HostEdit::Set {
                    alias,
                    max_tasks: input["maxTasks"].as_f64(),
                    paused: input["paused"].as_bool(),
                    session: input["session"].as_str(),
                },
                _ => panic!("unknown op"),
            };
            match edit_host(
                input["before"].as_str().unwrap_or(""),
                Path::new("strategy.yaml"),
                "default",
                edit,
            ) {
                Ok(after) => json!({"after":after}),
                Err(_) => json!({"rejected":true,"unchanged":input["before"]}),
            }
        };
        println!("{output}");
    }
    Ok(())
}
