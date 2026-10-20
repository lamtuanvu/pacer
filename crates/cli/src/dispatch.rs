use crate::core_exec::{CoreMissing, child_env, exec_core, resolve_core};
use std::collections::HashMap;

pub fn main(argv: Vec<String>) -> i32 {
    let args = argv.get(1..).unwrap_or_default();
    if args.len() == 1 && matches!(args[0].as_str(), "--version" | "version") {
        println!(
            "pacer {}",
            option_env!("PACER_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
        );
        return 0;
    }
    if args.first().is_some_and(|a| a == "status") && args.iter().any(|a| a == "--line") {
        return crate::status_line::run(&args[1..]);
    }
    let exe = match std::env::current_exe().and_then(|p| p.canonicalize()) {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("pacer: could not locate executable: {error}");
            return 1;
        }
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    match resolve_core(&env, &exe) {
        Ok(core) => {
            let env = child_env(&env, &exe);
            if args.first().is_some_and(|a| a == "api") && args.iter().any(|a| a == "--stdio") {
                pacer_server::run_stdio_blocking(core, env)
            } else if args.first().is_some_and(|a| a == "serve") {
                let value = args
                    .windows(2)
                    .find(|pair| pair[0] == "--port")
                    .map(|pair| pair[1].clone())
                    .or_else(|| env.get("PACER_PORT").cloned())
                    .unwrap_or_else(|| "4317".into());
                match value.parse::<u16>() {
                    Ok(port) => pacer_server::run_serve_blocking(core, env, port),
                    Err(_) => {
                        eprintln!("pacer: invalid serve port: {value}");
                        2
                    }
                }
            } else {
                exec_core(&core, args, &env)
            }
        }
        Err(error) => {
            eprintln!("pacer: {error}");
            if matches!(error, CoreMissing::InvalidArgv) {
                2
            } else {
                1
            }
        }
    }
}
