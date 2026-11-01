//! Line-oriented validator used by the TypeScript differential test.
use pacer_config::strategy::{StrategyError, validate_strategy};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::Path;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        let raw: Value = serde_json::from_str(&line).map_err(io::Error::other)?;
        let result = match validate_strategy(&raw, Path::new("strategy.yaml"), "differential") {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(StrategyError::Invalid { problems, .. }) => {
                json!({"ok": false, "code": "invalid", "problems": problems})
            }
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        };
        serde_json::to_writer(&mut stdout, &result)?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}
