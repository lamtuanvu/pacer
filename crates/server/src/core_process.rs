//! The environment and working directory the TypeScript core runs CLI
//! commands with (`process.env`, `process.cwd()`), so native operations can
//! run `opencode models` as Core would. Without a working directory the
//! operations stay forwarded.
use crate::stdio_plugins::HostSocket;
use pacer_models::{CoreProcess, set_core_process};
use pacer_plugin_runtime::HOST_SOCKET_ENV;
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
};

/// Keys Core deletes from `process.env` at startup.
const CONSUMED: [&str; 3] = [
    "PACER_INTERNAL_NATIVE_BOOTSTRAP",
    "PACER_INTERNAL_TOKEN",
    "PACER_NATIVE_CONFIG_SYNC_KEY",
];

fn record(mut env: BTreeMap<OsString, OsString>) {
    for key in CONSUMED {
        env.remove(&OsString::from(key));
    }
    set_core_process(std::env::current_dir().ok().map(|cwd| CoreProcess {
        env: env.into_iter().collect(),
        cwd,
    }));
}

/// `serve`: the core child starts from a cleared environment (`core_child::command`).
pub(crate) fn record_serve(env: &HashMap<String, String>) {
    let mut core: BTreeMap<OsString, OsString> = env
        .iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
    core.remove(&OsString::from("BUN_OPTIONS"));
    core.remove(&OsString::from("NODE_OPTIONS"));
    core.insert("PACER_INTERNAL_PARENT_PIPE".into(), "1".into());
    record(core);
}

/// `api --stdio`: the core child inherits this process's environment, then
/// takes the child map and the host socket decision.
pub(crate) fn record_stdio(env: &HashMap<String, String>, socket: &HostSocket) {
    let mut core: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    core.extend(
        env.iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value))),
    );
    match socket {
        HostSocket::Inherit => {}
        HostSocket::Unset => {
            core.remove(&OsString::from(HOST_SOCKET_ENV));
        }
        HostSocket::Set(path) => {
            core.insert(HOST_SOCKET_ENV.into(), path.into());
        }
    }
    record(core);
}
