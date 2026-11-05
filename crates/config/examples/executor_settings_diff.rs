//! JSON-line driver for executor-settings library parity on disposable homes.
use pacer_config::executor_settings::{read_executor_settings, save_executor_settings};
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
            Some("read") => match read_executor_settings(home) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            Some("save") => match save_executor_settings(home, &input["input"]) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            _ => json!({"ok":false,"error":"unknown op"}),
        };
        writeln!(stdout, "{output}")?;
    }
    stdout.flush()
}
