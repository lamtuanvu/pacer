//! Cross-runtime driver for `files.search`: `files_search_probe <pacer_home> <params-json>`.
//! Prints `{"result": ...}` or `{"error": {code, message, hint?}}` like the core bridge.
#![allow(clippy::expect_used)]
use pacer_foundation::Ctx;
use pacer_lifecycle::files_search::files_search;
use serde_json::{Value, json};
use std::{env, path::PathBuf};

fn main() {
    let mut args = env::args().skip(1);
    let pacer_home = PathBuf::from(args.next().expect("pacer_home"));
    let params: Value =
        serde_json::from_str(&args.next().unwrap_or_else(|| "{}".into())).expect("params json");
    let vars: std::collections::HashMap<String, String> = env::vars().collect();
    let ctx = Ctx {
        home: PathBuf::from(vars.get("HOME").cloned().unwrap_or_default()),
        pacer_home,
        env: vars,
        now: pacer_foundation::ctx::unix_now(),
    };
    let out = match files_search(&ctx, &params, || false) {
        Ok(result) => json!({"result": result}),
        Err(error) => {
            let mut body = json!({"code": error.code, "message": error.message});
            if let Some(hint) = error.hint {
                body["hint"] = json!(hint);
            }
            json!({"error": body})
        }
    };
    println!("{out}");
}
