//! JSON-line driver for library-only config write parity on disposable homes.
use pacer_config::{config_writes, doc, notifications, strategy_write};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::Path;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let input: Value = serde_json::from_str(&line?).map_err(io::Error::other)?;
        let home = Path::new(input["home"].as_str().unwrap_or(""));
        let output = match input["op"].as_str() {
            Some("yaml.stringify") => {
                json!({"ok":true,"value":doc::stringify_bun(&input["value"])})
            }
            Some("routing.set") => {
                let rules = input["rules"]
                    .as_array()
                    .ok_or_else(|| io::Error::other("rules must be an array"))?;
                match config_writes::set_routing(home, rules) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            }
            Some("runner.reorder") => {
                let ids = input["ids"]
                    .as_array()
                    .ok_or_else(|| io::Error::other("ids must be an array"))?;
                let ids = ids
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                match config_writes::reorder_runners(home, &ids) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            }
            Some("runner.set") => match config_writes::set_runner(
                home,
                input["id"].as_str().unwrap_or(""),
                &input["options"],
            ) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            Some("runner.remove") => {
                match config_writes::remove_runner(home, input["id"].as_str().unwrap_or("")) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            }
            Some("notifications.set") => {
                match notifications::set_level(home, input["level"].as_str().unwrap_or("")) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            }
            Some("notifications.get") => match notifications::get_level(
                home,
                Path::new(input["legacyPluginData"].as_str().unwrap_or("")),
            ) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            Some("strategy.save") => match strategy_write::save_strategy(
                home,
                input["name"].as_str().unwrap_or(""),
                &input["draft"],
                input["reason"].as_str().unwrap_or(""),
                strategy_write::SaveOptions {
                    who: input["who"].as_str().unwrap_or("agent"),
                    now_iso: input["nowIso"].as_str().unwrap_or(""),
                    overwrite: input["overwrite"].as_bool().unwrap_or(false),
                    active_ok: input["activeOk"].as_bool().unwrap_or(false),
                },
            ) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            Some("strategy.use") => {
                match strategy_write::use_strategy(home, input["name"].as_str().unwrap_or("")) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            }
            Some("strategy.remove") => {
                match strategy_write::remove_strategy(home, input["name"].as_str().unwrap_or("")) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            }
            _ => return Err(io::Error::other("unknown write operation")),
        };
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}
