//! The environment and working directory the TypeScript core runs CLI
//! commands with (`process.env`, `process.cwd()`), so native operations can
//! run `opencode models` as Core would. Without a working directory the
//! operations stay forwarded.
use crate::stdio_plugins::HostSocket;
use pacer_models::{CoreProcess, set_core_process};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::{OsStr, OsString},
};

#[cfg(test)]
mod tests;

/// Keys Core deletes from `process.env` at startup. Stripped on both doors,
/// even where that door's Core keeps one, so no credential reaches a CLI.
const CONSUMED: [&str; 4] = [
    "PACER_HOST_SOCKET_KEY",
    "PACER_INTERNAL_NATIVE_BOOTSTRAP",
    "PACER_INTERNAL_TOKEN",
    "PACER_NATIVE_CONFIG_SYNC_KEY",
];

type Env = BTreeMap<OsString, OsString>;

fn strip(mut env: Env) -> Env {
    for key in CONSUMED {
        env.remove(OsStr::new(key));
    }
    env
}

fn record(env: Env) {
    set_core_process(std::env::current_dir().ok().map(|cwd| CoreProcess {
        env: env.into_iter().collect(),
        cwd,
    }));
}

/// `serve`: the core child starts from a cleared environment (`core_child::command`).
fn serve_env(env: &HashMap<String, String>) -> Env {
    let mut core: Env = env
        .iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
    core.remove(OsStr::new("BUN_OPTIONS"));
    core.remove(OsStr::new("NODE_OPTIONS"));
    core.insert("PACER_INTERNAL_PARENT_PIPE".into(), "1".into());
    strip(core)
}

/// `api --stdio`: the core child inherits `inherited`, then takes the child
/// map and whatever `HostSocket::apply` sets or removes on its command.
fn stdio_env(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    env: &HashMap<String, String>,
    socket: &HostSocket,
) -> Env {
    let mut core: Env = inherited.into_iter().collect();
    let mut command = tokio::process::Command::new("core");
    socket.apply(command.envs(env));
    for (key, value) in command.as_std().get_envs() {
        match value {
            Some(value) => core.insert(key.to_owned(), value.to_owned()),
            None => core.remove(key),
        };
    }
    strip(core)
}

pub(crate) fn record_serve(env: &HashMap<String, String>) {
    record(serve_env(env));
}

pub(crate) fn record_stdio(env: &HashMap<String, String>, socket: &HostSocket) {
    record(stdio_env(std::env::vars_os(), env, socket));
}
