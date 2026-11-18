//! Core's secrets travel on its stdin, never in its environment (#918, ADR 0027).
//!
//! Any process running as the same user, sandboxed or not, can read another
//! process's initial environment (`sysctl(KERN_PROCARGS2)` on macOS,
//! `/proc/<pid>/environ` on Linux), and no usable Seatbelt rule blocks it. So
//! serve and the stdio door hand their Core child its private credentials as
//! one frame, the first bytes Core reads from stdin:
//!
//! `pacer-core-secrets/1 <length>\n` followed by `<length>` bytes of JSON with
//! any of `internalToken`, `ownerKey` and `nativeConfigSyncKey`, each 64 hex
//! digits.
//!
//! [`ANNOUNCE_ENV`] tells Core a frame comes. Core (`src/core-secrets.ts`)
//! reads it once at startup and refuses to start when it is missing or
//! malformed. A paired native Core reads it after its parent channel's `B`.
use pacer_plugin_runtime::HOST_SOCKET_KEY_ENV;
use std::io;
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    process::Command,
};

/// Announces the frame; it carries no secret.
pub(crate) const ANNOUNCE_ENV: &str = "PACER_CORE_SECRETS";
const ANNOUNCE: &str = "stdin/1";
const MAGIC: &str = "pacer-core-secrets/1";
/// Names Core never receives in its environment, even when the door inherited them.
pub(crate) const SECRET_ENV: [&str; 3] = [
    HOST_SOCKET_KEY_ENV,
    "PACER_INTERNAL_TOKEN",
    "PACER_NATIVE_CONFIG_SYNC_KEY",
];

/// One Core generation's secrets. No `Debug`: nothing may print them.
#[derive(Clone, Default)]
pub(crate) struct CoreSecrets {
    pub(crate) internal_token: Option<String>,
    pub(crate) owner_key: Option<String>,
    pub(crate) native_config_sync_key: Option<String>,
}

impl CoreSecrets {
    pub(crate) fn frame(&self) -> Vec<u8> {
        let mut body = serde_json::Map::new();
        for (name, value) in [
            ("internalToken", &self.internal_token),
            ("ownerKey", &self.owner_key),
            ("nativeConfigSyncKey", &self.native_config_sync_key),
        ] {
            if let Some(value) = value {
                body.insert(name.into(), value.clone().into());
            }
        }
        let body = serde_json::Value::Object(body).to_string();
        let mut frame = format!("{MAGIC} {}\n", body.len()).into_bytes();
        frame.extend_from_slice(body.as_bytes());
        frame
    }
}

/// Keep inherited secrets out of Core's environment and announce the frame.
/// Call after every other environment change to `command`.
pub(crate) fn announce(command: &mut Command) -> &mut Command {
    for name in SECRET_ENV {
        command.env_remove(name);
    }
    command.env(ANNOUNCE_ENV, ANNOUNCE)
}

/// Write the frame as the first bytes on Core's stdin.
pub(crate) async fn send(
    stdin: &mut (impl AsyncWrite + Unpin),
    secrets: &CoreSecrets,
) -> io::Result<()> {
    stdin.write_all(&secrets.frame()).await?;
    stdin.flush().await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::{collections::HashMap, ffi::OsStr};

    #[test]
    fn frame_is_versioned_length_prefixed_json() {
        let secrets = CoreSecrets {
            internal_token: Some("a".repeat(64)),
            owner_key: None,
            native_config_sync_key: Some("b".repeat(64)),
        };
        let frame = String::from_utf8(secrets.frame()).unwrap();
        let (header, body) = frame.split_once('\n').unwrap();
        assert_eq!(header, format!("pacer-core-secrets/1 {}", body.len()));
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"internalToken": "a".repeat(64), "nativeConfigSyncKey": "b".repeat(64)})
        );
        assert_eq!(
            String::from_utf8(CoreSecrets::default().frame()).unwrap(),
            "pacer-core-secrets/1 2\n{}"
        );
    }

    #[test]
    fn announce_removes_inherited_secrets_and_sets_only_the_marker() {
        let mut command = Command::new("true");
        for name in SECRET_ENV {
            command.env(name, "inherited");
        }
        announce(&mut command);
        let env = command
            .as_std()
            .get_envs()
            .map(|(name, value)| (name.to_owned(), value.map(ToOwned::to_owned)))
            .collect::<HashMap<_, _>>();
        for name in SECRET_ENV {
            // `None` removes an inherited value from the child's environment.
            assert_eq!(env[OsStr::new(name)], None, "{name}");
        }
        assert_eq!(env[OsStr::new(ANNOUNCE_ENV)], Some("stdin/1".into()));
    }
}
