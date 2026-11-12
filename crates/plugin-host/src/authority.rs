//! Host-issued, call-local authority. Plugin parameters never create resources.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path},
    time::Instant,
};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthorityError {
    #[error("owning plugin call expired or was revoked")]
    Expired,
    #[error("capability is not granted to the owning call: {0}")]
    Denied(String),
    #[error("invalid capability request: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ReadResource {
    pub path: String,
    pub kind: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct WriteResource {
    pub path: String,
    pub kind: String,
    pub operations: Vec<String>,
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandResource {
    pub argv: Vec<String>,
    pub timeout_ms: u64,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub secret_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub mode: Option<crate::SpawnMode>,
    #[serde(default)]
    pub input: Option<Vec<u8>>,
    #[serde(default)]
    pub input_sha256: Option<String>,
    #[serde(default)]
    pub capture: Option<crate::SpawnCapture>,
    #[serde(default)]
    pub suppress_output: bool,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostOperationResource {
    pub alias: String,
    pub host_fingerprint: String,
    pub script: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub max_bytes: u64,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallResources {
    #[serde(default)]
    pub reads: Vec<ReadResource>,
    #[serde(default)]
    pub writes: Vec<WriteResource>,
    #[serde(default)]
    pub commands: Vec<CommandResource>,
    #[serde(default)]
    pub hosts: Vec<HostOperationResource>,
    #[serde(default)]
    pub secret_aliases: HashMap<String, String>,
    #[serde(default)]
    pub http: Option<HttpResource>,
    #[serde(default)]
    pub worktree: Option<WorktreeResource>,
    #[serde(default)]
    pub orca_attempt: Option<crate::OrcaAttemptResource>,
    #[serde(default)]
    pub orca_live: Option<crate::OrcaLiveResource>,
    #[serde(default)]
    pub executor_claim: Option<ExecutorClaimResource>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorLaunchFileResource {
    pub name: String,
    pub content: String,
    pub mode: u32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorLaunchResource {
    pub argv: Vec<String>,
    pub cwd: String,
    pub executable: String,
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub umask: Option<String>,
    #[serde(default)]
    pub keep_color: Option<Vec<String>>,
    #[serde(default)]
    pub files: Option<Vec<ExecutorLaunchFileResource>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorClaimResource {
    pub task_id: String,
    pub attempt: u64,
    pub provider_id: String,
    pub executor: String,
    pub launch: ExecutorLaunchResource,
}
#[derive(Clone, Debug, Deserialize)]
pub struct HttpResource {
    pub hosts: Vec<String>,
    #[serde(default)]
    pub origins: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeResource {
    pub task_id: String,
    pub attempt: u64,
    pub base_sha: String,
}
pub const ORCA_PROVIDER: &str = "pacer-exec-orca";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaAttemptResource {
    pub task_id: String,
    pub attempt: u64,
    pub provider_id: String,
    pub executor: String,
    pub session: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaLiveResource {
    pub task_id: String,
    pub attempt: u64,
    pub provider_id: String,
    pub worker: String,
    pub terminal: String,
    pub incarnation: Option<String>,
    pub action: String,
    pub why: Option<String>,
}

/// A single call owns this value. Effects consume one-use grants before execution.
pub struct CallAuthority {
    resources: CallResources,
    grants: HashSet<String>,
    expires: Instant,
    revoked: bool,
    used_hosts: HashSet<usize>,
    worktree_used: bool,
    orca_live_used: bool,
    executor_claim_used: bool,
    /// Test seam: reports expiry whenever the predicate holds.
    #[cfg(feature = "testing")]
    pub expire_when: Option<Box<dyn Fn() -> bool + Send + Sync>>,
}

impl CallAuthority {
    pub fn new(
        resources: CallResources,
        grants: impl IntoIterator<Item = String>,
        expires: Instant,
    ) -> Self {
        Self {
            resources,
            grants: grants.into_iter().collect(),
            expires,
            revoked: false,
            used_hosts: HashSet::new(),
            worktree_used: false,
            orca_live_used: false,
            executor_claim_used: false,
            #[cfg(feature = "testing")]
            expire_when: None,
        }
    }
    pub fn revoke(&mut self) {
        self.revoked = true;
    }
    pub fn active(&self) -> Result<(), AuthorityError> {
        #[cfg(feature = "testing")]
        if self.expire_when.as_ref().is_some_and(|expired| expired()) {
            return Err(AuthorityError::Expired);
        }
        if self.revoked || Instant::now() >= self.expires {
            Err(AuthorityError::Expired)
        } else {
            Ok(())
        }
    }
    pub fn granted(&self, capability: &str) -> Result<(), AuthorityError> {
        self.active()?;
        if self.grants.contains(capability) {
            Ok(())
        } else {
            Err(AuthorityError::Denied(capability.into()))
        }
    }
    pub fn deadline(&self) -> Instant {
        self.expires
    }
    pub fn orca(
        &mut self,
        plugin_id: &str,
        task_id: &str,
        attempt: u64,
        action: Option<&str>,
    ) -> Result<(), AuthorityError> {
        self.granted("orca")?;
        if plugin_id != ORCA_PROVIDER {
            return Err(AuthorityError::Denied("Orca provider identity".into()));
        }
        if let Some(action) = action {
            let g = self
                .resources
                .orca_live
                .as_ref()
                .filter(|g| {
                    g.task_id == task_id
                        && g.attempt == attempt
                        && g.provider_id == plugin_id
                        && g.action == action
                        && !self.orca_live_used
                })
                .ok_or_else(|| AuthorityError::Denied("Orca live worker was not issued".into()))?;
            let _ = g;
            self.orca_live_used = true;
        } else if !self.resources.orca_attempt.as_ref().is_some_and(|g| {
            g.task_id == task_id && g.attempt == attempt && g.provider_id == plugin_id
        }) {
            return Err(AuthorityError::Denied("Orca attempt was not issued".into()));
        }
        Ok(())
    }
    pub fn read(&self, path: &str) -> Result<&ReadResource, AuthorityError> {
        self.granted("fs.read")?;
        valid_path(path)?;
        self.resources
            .reads
            .iter()
            .find(|r| r.path == path && r.kind == "file")
            .ok_or_else(|| AuthorityError::Denied("read path was not issued".into()))
    }
    pub fn read_directory(&self, path: &str) -> Result<&ReadResource, AuthorityError> {
        self.granted("fs.read")?;
        valid_path(path)?;
        let normalized = normalize_path(path);
        self.resources
            .reads
            .iter()
            .find(|r| {
                r.kind == "codex-logs"
                    && valid_path(&r.path).is_ok()
                    && normalize_path(&r.path) == normalized
            })
            .ok_or_else(|| AuthorityError::Denied("read directory was not issued".into()))
    }
    pub fn write(&self, path: &str, operation: &str) -> Result<&WriteResource, AuthorityError> {
        self.granted("fs.write")?;
        valid_path(path)?;
        self.resources
            .writes
            .iter()
            .find(|r| r.path == path && r.operations.iter().any(|o| o == operation))
            .ok_or_else(|| AuthorityError::Denied("write path was not issued".into()))
    }
    pub fn command(
        &self,
        argv: &[String],
        timeout_ms: u64,
        cwd: Option<&str>,
        stdin: Option<&str>,
    ) -> Result<&CommandResource, AuthorityError> {
        self.granted("process.spawn")?;
        if argv.is_empty() || argv.len() > 32 || timeout_ms == 0 || timeout_ms > 1_800_000 {
            return Err(AuthorityError::Invalid("command bounds".into()));
        }
        self.resources
            .commands
            .iter()
            .find(|r| {
                r.argv == argv
                    && timeout_ms <= r.timeout_ms
                    && (r.mode == Some(crate::SpawnMode::CodexLive) || r.cwd.as_deref() == cwd)
                    && r.stdin.as_deref() == stdin
            })
            .ok_or_else(|| AuthorityError::Denied("command was not issued".into()))
    }
    pub fn host_fetch(
        &self,
        alias: &str,
        timeout_ms: u64,
        max_bytes: u64,
    ) -> Result<HostOperationResource, AuthorityError> {
        self.granted("hosts")?;
        self.resources
            .hosts
            .iter()
            .find(|r| {
                r.alias == alias
                    && r.script == "BUNDLE_OUT"
                    && r.timeout_ms == timeout_ms
                    && r.max_bytes == max_bytes
            })
            .cloned()
            .ok_or_else(|| AuthorityError::Denied("bundle fetch was not issued".into()))
    }
    pub fn consume_host(&mut self, request: &HostOperationResource) -> Result<(), AuthorityError> {
        self.granted("hosts")?;
        let index = self
            .resources
            .hosts
            .iter()
            .enumerate()
            .find(|(i, r)| {
                !self.used_hosts.contains(i)
                    && r.alias == request.alias
                    && r.host_fingerprint == request.host_fingerprint
                    && r.script == request.script
                    && r.args == request.args
                    && request.timeout_ms <= r.timeout_ms
                    && request.max_bytes <= r.max_bytes
            })
            .map(|(i, _)| i)
            .ok_or_else(|| AuthorityError::Denied("host operation was not issued".into()))?;
        self.used_hosts.insert(index);
        Ok(())
    }
    pub fn consume_worktree(
        &mut self,
        task_id: &str,
        attempt: u64,
        base_sha: &str,
    ) -> Result<(), AuthorityError> {
        self.granted("worktree")?;
        if self.worktree_used
            || !self.resources.worktree.as_ref().is_some_and(|r| {
                r.task_id == task_id && r.attempt == attempt && r.base_sha == base_sha
            })
        {
            return Err(AuthorityError::Denied(
                "worktree effect was not issued".into(),
            ));
        }
        self.worktree_used = true;
        Ok(())
    }
    pub fn consume_executor_claim(
        &mut self,
        task_id: &str,
        attempt: u64,
    ) -> Result<(), AuthorityError> {
        self.granted("process.spawn")?;
        let issued =
            self.resources.executor_claim.as_ref().ok_or_else(|| {
                AuthorityError::Denied("executor run claim was not issued".into())
            })?;
        if self.executor_claim_used || issued.task_id != task_id || issued.attempt != attempt {
            return Err(AuthorityError::Denied(
                "executor run claim was not issued".into(),
            ));
        }
        self.executor_claim_used = true;
        Ok(())
    }
    pub fn worktree(
        &self,
        task_id: &str,
        attempt: u64,
    ) -> Result<&WorktreeResource, AuthorityError> {
        self.granted("worktree")?;
        self.resources
            .worktree
            .as_ref()
            .filter(|r| r.task_id == task_id && r.attempt == attempt)
            .ok_or_else(|| AuthorityError::Denied("worktree placement was not issued".into()))
    }
    pub fn secret_alias(&self, alias: &str) -> Result<&str, AuthorityError> {
        self.granted("secrets.resolve")?;
        self.resources
            .secret_aliases
            .get(alias)
            .map(String::as_str)
            .ok_or_else(|| AuthorityError::Denied("secret alias was not issued".into()))
    }
    pub fn http_destination(
        &self,
        url: &url::Url,
        scopes: &[String],
        explicit_wildcard_grant: bool,
    ) -> Result<(), AuthorityError> {
        self.granted("net.http")?;
        let host = url
            .host_str()
            .ok_or_else(|| AuthorityError::Invalid("HTTP host".into()))?;
        let http = self
            .resources
            .http
            .as_ref()
            .ok_or_else(|| AuthorityError::Denied("HTTP host was not issued".into()))?;
        let matches = |scope: &str| -> Result<bool, AuthorityError> {
            if scope == "*" {
                return Ok(explicit_wildcard_grant);
            }
            let suffix = scope.strip_prefix("*.");
            let raw = suffix.unwrap_or(scope);
            let parsed = url::Url::parse(&format!("http://{raw}"))
                .map_err(|_| AuthorityError::Denied("invalid captured HTTP host scope".into()))?;
            if raw.is_empty()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.port().is_some()
                || parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(AuthorityError::Denied(
                    "invalid captured HTTP host scope".into(),
                ));
            }
            let normalized = parsed
                .host_str()
                .ok_or_else(|| AuthorityError::Denied("invalid captured HTTP host scope".into()))?;
            Ok(if suffix.is_some() {
                host.ends_with(&format!(".{normalized}"))
            } else {
                host == normalized
            })
        };
        if !scopes
            .iter()
            .map(|s| matches(s))
            .collect::<Result<Vec<_>, _>>()?
            .contains(&true)
            || !http
                .hosts
                .iter()
                .map(|s| matches(s))
                .collect::<Result<Vec<_>, _>>()?
                .contains(&true)
        {
            return Err(AuthorityError::Denied(
                "HTTP destination is outside the owning call scopes".into(),
            ));
        }
        if let Some(origins) = &http.origins {
            let origin = url.origin().ascii_serialization();
            for issued in origins {
                let parsed = url::Url::parse(issued)
                    .map_err(|_| AuthorityError::Denied("invalid captured HTTP origin".into()))?;
                if !["http", "https"].contains(&parsed.scheme())
                    || parsed.origin().ascii_serialization() != *issued
                {
                    return Err(AuthorityError::Denied(
                        "invalid captured HTTP origin".into(),
                    ));
                }
            }
            if !origins.iter().any(|issued| issued == &origin) {
                return Err(AuthorityError::Denied("HTTP origin was not issued".into()));
            }
        }
        Ok(())
    }
    pub fn http_origins(&self) -> Option<&[String]> {
        self.resources.http.as_ref()?.origins.as_deref()
    }
}

pub fn valid_path(path: &str) -> Result<(), AuthorityError> {
    if path.is_empty()
        || crate::js_semantics::utf16_len(path) > 4096
        || path.contains('\0')
        || !Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || path
            .split(['/', '\\'])
            .any(|part| part == "." || part == "..")
    {
        return Err(AuthorityError::Denied("invalid absolute path".into()));
    }
    Ok(())
}

pub fn normalize_path(path: &str) -> String {
    Path::new(path)
        .components()
        .collect::<std::path::PathBuf>()
        .to_string_lossy()
        .into_owned()
}

#[derive(Clone, Debug, Default)]
pub struct ScopeRoots {
    pub home: Option<String>,
    pub pacer_home: Option<String>,
    pub account_home: Option<String>,
}

impl ScopeRoots {
    pub fn declares_directory(
        &self,
        scopes: &[String],
        directory: &str,
    ) -> Result<bool, AuthorityError> {
        valid_path(directory)?;
        if self.declares_path(scopes, directory)? {
            return Ok(true);
        }
        let prefix = format!("{}/", directory.trim_end_matches('/'));
        for scope in scopes {
            let expanded = self.expand(scope)?;
            if expanded.is_some_and(|value| value.starts_with(&prefix)) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn expand(&self, scope: &str) -> Result<Option<String>, AuthorityError> {
        let mut value = scope.to_string();
        for (name, root) in [
            ("HOME", &self.home),
            ("PACER_HOME", &self.pacer_home),
            ("ACCOUNT_HOME", &self.account_home),
        ] {
            for marker in [format!("${{{name}}}"), format!("${name}")] {
                if value.contains(&marker) {
                    let Some(root) = root else {
                        return Ok(None);
                    };
                    valid_path(root)?;
                    value = value.replace(&marker, root);
                }
            }
        }
        if value.contains('$') {
            return Err(AuthorityError::Denied("unknown scope variable".into()));
        }
        valid_path(&value)?;
        Ok(Some(value))
    }

    pub fn declares_path(&self, scopes: &[String], path: &str) -> Result<bool, AuthorityError> {
        valid_path(path)?;
        for scope in scopes {
            let Some(value) = self.expand(scope)? else {
                continue;
            };
            if crate::bun_glob::matches_bun_scope(&value, path)
                .map_err(|_| AuthorityError::Denied("invalid declared scope".into()))?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn scopes_expand_only_known_anchored_roots() {
        let roots = ScopeRoots {
            home: Some("/fixture/home".into()),
            pacer_home: Some("/fixture/pacer".into()),
            account_home: None,
        };
        assert!(
            roots
                .declares_path(
                    &["${HOME}/logs/*.jsonl".into()],
                    "/fixture/home/logs/a.jsonl"
                )
                .unwrap()
        );
        assert!(
            !roots
                .declares_path(
                    &["$ACCOUNT_HOME/logs/*.jsonl".into()],
                    "/fixture/home/logs/a.jsonl"
                )
                .unwrap()
        );
        assert!(
            roots
                .declares_path(&["$UNKNOWN/file".into()], "/fixture/home/file")
                .is_err()
        );
        assert!(
            roots
                .declares_path(&["/fixture/home/../else".into()], "/fixture/else")
                .is_err()
        );
    }

    #[test]
    fn absolute_paths_reject_dot_segments_separated_by_backslash() {
        for path in [
            "/logs/../secret",
            "/logs\\..\\secret",
            "/logs\\.\\rollout-a.jsonl",
        ] {
            assert!(valid_path(path).is_err(), "{path}");
        }
    }
    #[test]
    fn single_star_does_not_admit_nested_path() {
        let roots = ScopeRoots::default();
        assert!(
            !roots
                .declares_path(&["/tmp/allowed/*".into()], "/tmp/allowed/sub/secret")
                .unwrap()
        );
        assert!(
            roots
                .declares_path(&["/tmp/allowed/*".into()], "/tmp/allowed/file")
                .unwrap()
        );
    }
}
