//! Workspace maintenance command dispatcher.
use std::{env, error::Error, fs, path::Path, process::ExitCode};
use xtask::{deps, loc};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("missing workspace root")?;
    let policy = deps::Policy::from_toml(&fs::read_to_string(root.join("xtask/crates.toml"))?)?;
    let args: Vec<_> = env::args().skip(1).collect();
    let check = match args.as_slice() {
        [command] if command == "loc" || command == "deps" => false,
        [command, flag] if command == "loc" && flag == "--check" => true,
        _ => return Err("usage: cargo xtask loc [--check] | deps".into()),
    };
    let metadata = deps::metadata(root)?;
    if args[0] == "deps" {
        let errors = deps::check_metadata(&policy, &metadata);
        if !errors.is_empty() {
            return Err(errors.join("\n").into());
        }
        println!("Dependency policy passed (CRATE-2, CRATE-4, CRATE-5, CRATE-6).");
    } else {
        let mut failed = false;
        println!("crate | layer | LOC | generated | budget state");
        for package in metadata
            .packages
            .iter()
            .filter(|p| metadata.workspace_members.contains(&p.id))
        {
            let rules = policy
                .crates
                .get(&package.name)
                .ok_or_else(|| format!("CRATE-4: unknown workspace crate {}", package.name))?;
            let dir = Path::new(&package.manifest_path)
                .parent()
                .ok_or("missing crate directory")?;
            let lines = loc::try_count(dir)?;
            let over = loc::exceeds_budget(&policy.limits, rules, &package.name, &lines);
            failed |= over;
            let state = if over {
                "FAIL"
            } else if lines.code > policy.limits.warn {
                "WARN"
            } else if lines.code > policy.limits.target {
                "above target"
            } else {
                "OK"
            };
            println!(
                "{} | {} | {} | {} | {}",
                package.name, rules.layer, lines.code, lines.generated, state
            );
            if lines.code > policy.limits.warn {
                eprintln!(
                    "CRATE-1: warning: {} exceeds {} LOC",
                    package.name, policy.limits.warn
                );
            }
        }
        if check && failed {
            return Err("CRATE-1/2/3/7: crate size policy failed".into());
        }
    }
    Ok(())
}
