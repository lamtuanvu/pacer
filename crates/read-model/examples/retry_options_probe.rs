//! Line-oriented test adapter for `retry::retry_options` with injected broker
//! readings. Never installed or registered as a native op.
use pacer_foundation::Ctx;
use pacer_read_model::{Error, js::*, retry};
use pacer_store::{StoreError, TaskStore};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?)?;
        let ctx = Ctx::with(
            text(&input["home"]).into(),
            text(&input["pacerHome"]).into(),
            HashMap::new(),
            num(&input["now"]),
        );
        let result = TaskStore::open(&ctx.pacer_home)
            .map_err(Error::from)
            .and_then(|mut store| {
                let task = retry::retry_task(&mut store, text(&input["id"]))?;
                retry::retry_options(&ctx, &mut store, &task, &input["parts"])
            });
        let reply = match result {
            Ok(value) => json!({"result": value}),
            Err(Error::Store(StoreError::UnknownTask(id))) => {
                json!({"error": {"code": "unknown_task", "message": format!("unknown task {id}")}})
            }
            Err(error) => json!({"error": {"code": "internal", "message": error.to_string()}}),
        };
        writeln!(out, "{}", serde_json::to_string(&reply)?)?;
        out.flush()?;
    }
    Ok(())
}
