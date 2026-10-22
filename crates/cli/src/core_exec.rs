use std::os::unix::process::CommandExt;
use std::{collections::HashMap, path::Path, process::Command};

#[derive(Debug)]
pub enum CoreCommand {
    Argv(Vec<String>),
}

#[derive(Debug, thiserror::Error)]
pub enum CoreMissing {
    #[error("PACER_CORE_ARGV must be a non-empty JSON array of strings")]
    InvalidArgv,
    #[error("pacer-core is missing next to {0}. Reinstall pacer")]
    Missing(String),
}

pub fn resolve_core(env: &HashMap<String, String>, exe: &Path) -> Result<Vec<String>, CoreMissing> {
    if let Some(value) = env.get("PACER_CORE_ARGV") {
        let argv: Vec<String> =
            serde_json::from_str(value).map_err(|_| CoreMissing::InvalidArgv)?;
        return if argv.is_empty() {
            Err(CoreMissing::InvalidArgv)
        } else {
            Ok(argv)
        };
    }
    let core = exe.with_file_name("pacer-core");
    if core.is_file() {
        Ok(vec![core.to_string_lossy().into_owned()])
    } else {
        Err(CoreMissing::Missing(exe.display().to_string()))
    }
}

pub fn child_env(env: &HashMap<String, String>, exe: &Path) -> HashMap<String, String> {
    let mut child = env.clone();
    child.remove("BUN_OPTIONS");
    child.remove("NODE_OPTIONS");
    child
        .entry("PACER_BIN".into())
        .or_insert_with(|| exe.to_string_lossy().into_owned());
    child
}

pub fn exec_core(core: &[String], args: &[String], env: &HashMap<String, String>) -> ! {
    let error = if let Some((program, prefix)) = core.split_first() {
        Command::new(program)
            .args(prefix)
            .args(args)
            .env_clear()
            .envs(env)
            .exec()
    } else {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty core argv")
    };
    eprintln!("pacer: could not start pacer-core: {error}");
    std::process::exit(1)
}
