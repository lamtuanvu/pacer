use super::core_exec::exec_core;
use std::collections::HashMap;

/// `pacer plugin run <id>`: the one place a bundled plugin child starts. Until
/// `pacer-bundled` (C0) has a Rust entry for `<id>`, it execs
/// `pacer-core plugin run <id>`.
pub fn is_plugin_run(args: &[String]) -> bool {
    args.len() >= 2 && args[0] == "plugin" && args[1] == "run"
}

/// Run a bundled plugin by id, or print the usage line and return 2 when the
/// id is missing or the command is malformed (mirrors
/// `src/commands/plugins.ts`).
pub fn run(core: &[String], args: &[String], env: &HashMap<String, String>) -> i32 {
    if args.len() != 3 {
        eprintln!("usage: pacer plugin run <id>");
        return 2;
    }
    let forward = vec!["plugin".to_string(), "run".to_string(), args[2].clone()];
    exec_core(core, &forward, env)
}

/// Native path of `pacer plugin run <id>`: `Some(exit code)` when the table serves `id` in Rust.
/// `Some(0)` on clean EOF; `Some(1)` with "pacer: plugin <id>: <error>" on stderr; `None` when the
/// row is unknown or still TypeScript (B0b's `pacer-core plugin run <id>` then owns the child).
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
    use super::run_native;

    #[test]
    fn run_native_declines_typescript_and_unknown_rows() {
        // Every bundled row is still TypeScript in C0a, so the native path declines them all.
        assert_eq!(run_native("pacer-notify"), None);
        assert_eq!(run_native("nope"), None);
    }
}
