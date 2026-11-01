//! Line-oriented strategy write comparison driver for isolated test homes.
use pacer_config::strategy_write::{remove_strategy, use_strategy};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::Path;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let input: Value = serde_json::from_str(&line?).map_err(io::Error::other)?;
        let home = Path::new(input["home"].as_str().unwrap_or(""));
        let name = input["name"].as_str().unwrap_or("");
        let result = match input["op"].as_str() {
            Some("use") => use_strategy(home, name),
            Some("remove") => remove_strategy(home, name),
            _ => return Err(io::Error::other("unknown write operation")),
        };
        let output = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}
