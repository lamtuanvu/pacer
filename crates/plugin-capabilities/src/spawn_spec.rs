//! Host-issued process modes and exact context admission, matching capability-spawn.ts.
use crate::{AuthorityError, BrokerError, CommandResource};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum SpawnMode {
    CodexLive,
    PrepareBundle,
    PrepareRecover,
    BinaryUpload,
    StartInput,
    SessionDuplex,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SpawnCapture {
    pub stdout: String,
    pub stderr: String,
}
pub const CODEX_ARGV: &[&str] = &["codex", "-s", "read-only", "-a", "never", "app-server"];
pub const CODEX_REQUEST: &str = concat!(
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"pacer\",\"version\":\"1\"},\"capabilities\":{}}}\n",
    "{\"jsonrpc\":\"2.0\",\"method\":\"initialized\",\"params\":{}}\n",
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{}}\n"
);
fn denied() -> BrokerError {
    AuthorityError::Denied("process mode or input was not issued by the host".into()).into()
}
fn env_key(key: &str) -> bool {
    let mut b = key.bytes();
    b.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
impl CommandResource {
    pub fn has_context(&self) -> bool {
        self.cwd.is_some() || self.env.is_some() || self.secret_env.is_some()
    }
    pub fn matches(&self, params: &Value, ms: u64) -> bool {
        if params["argv"] != json!(self.argv)
            || ms > self.timeout_ms
            || self.mode == Some(SpawnMode::SessionDuplex)
            || match &self.stdin {
                Some(s) => params.get("stdin").and_then(Value::as_str) != Some(s),
                None => params.get("stdin").is_some(),
            }
        {
            return false;
        }
        if self.mode == Some(SpawnMode::CodexLive) || !self.has_context() {
            return params.get("env").is_none() && params.get("cwd").is_none();
        }
        if params.get("cwd").and_then(Value::as_str) != self.cwd.as_deref()
            || self.cwd.is_none() && params.get("cwd").is_some()
        {
            return false;
        }
        let mut expected = serde_json::Map::new();
        for (k, v) in self.env.iter().flatten() {
            expected.insert(k.clone(), json!(v));
        }
        for (k, v) in self.secret_env.iter().flatten() {
            expected.insert(k.clone(), json!({"secretRef":v}));
        }
        params.get("env") == Some(&Value::Object(expected))
    }
    pub fn validate(&self, account_home: Option<&str>) -> Result<(), BrokerError> {
        if self.argv.is_empty()
            || self.argv.len() > 32
            || self.argv[0] == "*"
            || Path::new(&self.argv[0]).is_absolute()
            || self
                .argv
                .iter()
                .any(|s| s.contains('\0') || crate::js_semantics::utf16_len(s) > 4096)
            || self
                .stdin
                .as_ref()
                .is_some_and(|s| s.len() > 262_144 || self.mode.is_some())
            || self.suppress_output && self.capture.is_some()
            || self
                .env
                .iter()
                .flatten()
                .any(|(k, v)| !env_key(k) || v.contains('\0'))
            || self.secret_env.iter().flatten().any(|(k, v)| {
                !env_key(k)
                    || !crate::valid_reference(v)
                    || self.env.as_ref().is_some_and(|e| e.contains_key(k))
            })
        {
            return Err(BrokerError::Invalid("issued command context"));
        }
        use SpawnMode::*;
        match self.mode {
            Some(PrepareBundle | StartInput | BinaryUpload) => {
                let input = self.input.as_ref().ok_or_else(denied)?;
                let (minimum, maximum, timeout) = match self.mode {
                    Some(PrepareBundle) => (0, 50 * 1024 * 1024, 60_000),
                    Some(BinaryUpload) => (1, 128 * 1024 * 1024, 300_000),
                    _ => (1, 50 * 1024 * 1024, 60_000),
                };
                let digest = format!("{:x}", Sha256::digest(input));
                if input.len() < minimum
                    || input.len() > maximum
                    || self.input_sha256.as_ref() != Some(&digest)
                    || self.argv[0] != "ssh"
                    || self.has_context()
                    || self.timeout_ms > timeout
                {
                    return Err(denied());
                }
            }
            Some(PrepareRecover | SessionDuplex) => {
                let maximum = if self.mode == Some(PrepareRecover) {
                    30_000
                } else {
                    60_000
                };
                if self.argv[0] != "ssh"
                    || self.input.is_some()
                    || self.input_sha256.is_some()
                    || self.has_context()
                    || self.timeout_ms > maximum
                {
                    return Err(denied());
                }
            }
            _ if self.input.is_some() || self.input_sha256.is_some() => return Err(denied()),
            _ => {}
        }
        if self.mode == Some(CodexLive)
            && (self.argv != CODEX_ARGV
                || account_home.is_none_or(|h| !Path::new(h).is_absolute())
                || self
                    .env
                    .as_ref()
                    .and_then(|e| e.get("CODEX_HOME"))
                    .map(String::as_str)
                    != account_home
                || self.cwd.is_some()
                || self.secret_env.is_some()
                || self.timeout_ms > 15_000)
        {
            return Err(denied());
        }
        Ok(())
    }
}
