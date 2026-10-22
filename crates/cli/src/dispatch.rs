use crate::core_exec::{CoreMissing, child_env, exec_core, resolve_core};
use std::collections::HashMap;

pub fn main(argv: Vec<String>) -> i32 {
    let args = argv.get(1..).unwrap_or_default();
    let version = option_env!("PACER_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    if std::env::var_os("PACER_WORK_GRANT").is_some() && args.first().is_some_and(|a| a == "status")
    {
        eprintln!("pacer: work grants cannot read global status");
        return 2;
    }
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
    if args.first().is_some_and(|arg| arg == "self-repair") {
        let base = match args {
            [_] => env
                .get("PACER_RELEASE_BASE")
                .map(String::as_str)
                .unwrap_or(""),
            [_, flag, base] if flag == "--base" => base,
            _ => {
                eprintln!("usage: pacer self-repair [--base <url>]");
                return 2;
            }
        };
        return match crate::self_repair::repair(&exe, version, base) {
            Ok(path) => {
                println!("pacer-core {version} ready at {}", path.display());
                0
            }
            Err(error) => {
                eprintln!("pacer: self-repair failed: {error}");
                1
            }
        };
    }
    if !env.contains_key("PACER_CORE_ARGV")
        && !crate::core_exec::is_bundled_executable(&exe)
        && env.get("PACER_NO_SELF_REPAIR").is_none_or(|s| s != "1")
    {
        let core = exe.with_file_name("pacer-core");
        if !crate::self_repair::is_current(&core, version, &env) {
            eprintln!("pacer: installing pacer-core {version}…");
            let base = env
                .get("PACER_RELEASE_BASE")
                .map(String::as_str)
                .unwrap_or("");
            if let Err(error) = crate::self_repair::repair(&exe, version, base) {
                eprintln!("pacer: self-repair failed: {error}");
                if !core.is_file() {
                    eprintln!(
                        "pacer: pacer-core is missing next to {}. Reinstall pacer",
                        exe.display()
                    );
                }
                return 1;
            }
            let _ = crate::self_repair::is_current(&core, version, &env);
        }
    }
    match resolve_core(&env, &exe) {
        Ok(core) => {
            let env = child_env(&env, &exe);
            // Only the exact transport forms run natively; usage, help and errors stay the core's.
            let words: Vec<&str> = args.iter().map(String::as_str).collect();
            if words == ["api", "--stdio"] {
                pacer_server::run_stdio_blocking(core, env)
            } else if matches!(words.as_slice(), ["serve"] | ["serve", "--port", _]) {
                let value = args
                    .get(2)
                    .cloned()
                    .or_else(|| env.get("PACER_PORT").cloned())
                    .unwrap_or_else(|| "4317".into());
                match value.parse::<u16>() {
                    Ok(port) => {
                        let mut service_argv = vec![exe.to_string_lossy().into_owned()];
                        service_argv.extend_from_slice(args);
                        pacer_server::run_serve_blocking(core, env, port, version, service_argv)
                    }
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
