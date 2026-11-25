use super::core_exec::exec_core;
use std::collections::HashMap;

/// `pacer plugin run <id>`: every shipped bundled plugin is served natively by
/// the front door. Only the one still-TypeScript row (`pacer-dev`, out of scope
/// for M3 C13) is forwarded to `pacer-core plugin run <id>`.
pub fn is_plugin_run(args: &[String]) -> bool {
    args.len() >= 2 && args[0] == "plugin" && args[1] == "run"
}

/// True only for a known bundled row that has no Rust port yet. Derived from
/// the table so adding the next native port needs no CLI edit.
pub fn is_typescript_fallback(id: &str) -> bool {
    pacer_bundled::is_typescript(id)
}

/// Forward the one TypeScript fallback to pacer-core. Callers have already
/// validated the arity; the native and unknown cases never reach here.
pub fn run(core: &[String], args: &[String], env: &HashMap<String, String>) -> i32 {
    let forward = vec!["plugin".to_string(), "run".to_string(), args[2].clone()];
    exec_core(core, &forward, env)
}

/// Native path of `pacer plugin run <id>`: `Some(exit code)` when the table serves `id` in Rust.
/// `Some(0)` on clean EOF; `Some(1)` with "pacer: plugin <id>: <error>" on stderr; `None` when the
/// row is unknown or still TypeScript.
pub fn run_native(id: &str) -> Option<i32> {
    match pacer_bundled::serve_stdio(id) {
        None => None,
        Some(Ok(())) => Some(0),
        Some(Err(error)) => {
            eprintln!("pacer: plugin {id}: {error}");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_typescript_fallback, run_native};

    #[test]
    fn only_the_workflow_plugin_is_a_typescript_fallback() {
        assert!(is_typescript_fallback("pacer-dev"));
        assert!(!is_typescript_fallback("pacer-notify"));
        assert!(!is_typescript_fallback("nope"));
    }

    #[test]
    fn native_rows_have_a_runner_and_unknown_rows_do_not() {
        // Do not call `run_native` here: it serves on stdio until EOF.
        assert!(pacer_bundled::native("pacer-notify").is_some());
        assert!(pacer_bundled::native("pacer-dev").is_none());
        assert!(pacer_bundled::native("nope").is_none());
        assert_eq!(run_native("nope"), None);
    }
}
