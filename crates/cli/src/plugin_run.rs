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
