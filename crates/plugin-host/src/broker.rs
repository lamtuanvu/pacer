//! Admission and transport for plugin-to-host capability calls in the shadow host.
//! Effects are supplied by the future native owner; this layer never calls the TS host.
use crate::authority::AuthorityError;
use crate::{
    CallAuthority, HostLeaseBroker, NativeRead, ParsedManifest, ProviderSnapshot, ScopeRoots,
    TransferKind, Transfers,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    future::Future,
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::time::timeout_at;

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error(transparent)]
    Authority(#[from] AuthorityError),
    #[error("invalid capability parameters: {0}")]
    Invalid(&'static str),
    #[error("capability deadline passed")]
    Timeout,
    #[error("effect failed: {0}")]
    Effect(String),
    #[error("host lease failed: {0}")]
    HostLease(String),
}

/// Effects receive already admitted arguments. Implementations must retain their
/// own filesystem descriptor, executable identity and network redirect checks.
pub trait CapabilityEffect {
    fn call(
        &mut self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
    fn provider_snapshot(&self, _alias: &str) -> Option<ProviderSnapshot> {
        None
    }
}

pub struct CapabilityBroker {
    manifest: ParsedManifest,
    authority: CallAuthority,
    transfers: Transfers,
    file_write: Option<(String, String, Option<u64>)>,
    features: Vec<String>,
    hosts: Option<HostLeaseBroker>,
    scope_roots: ScopeRoots,
    native_read: Option<NativeRead>,
    explicit_http_wildcard_grant: bool,
}

impl CapabilityBroker {
    pub fn new(manifest: ParsedManifest, authority: CallAuthority, features: Vec<String>) -> Self {
        Self {
            manifest,
            authority,
            transfers: Transfers::default(),
            file_write: None,
            features,
            hosts: None,
            scope_roots: ScopeRoots::default(),
            native_read: None,
            explicit_http_wildcard_grant: false,
        }
    }
    pub fn revoke(&mut self) {
        self.authority.revoke();
        self.transfers.revoke();
        self.file_write = None;
        if let Some(hosts) = &mut self.hosts {
            hosts.revoke();
        }
    }
    pub fn authority(&self) -> &CallAuthority {
        &self.authority
    }
    pub fn with_hosts(mut self, snapshots: impl IntoIterator<Item = ProviderSnapshot>) -> Self {
        self.hosts = Some(HostLeaseBroker::new(snapshots));
        self
    }
    pub fn with_scope_roots(mut self, roots: ScopeRoots) -> Self {
        self.scope_roots = roots;
        self
    }
    /// Set only from the host's explicit unbundled net.http grant at issuance.
    pub fn with_explicit_http_wildcard_grant(mut self, granted: bool) -> Self {
        self.explicit_http_wildcard_grant = granted;
        self
    }
    /// Capture exact regular-file descriptors before the plugin starts its call.
    pub fn with_native_read(
        mut self,
        resources: &[crate::ReadResource],
    ) -> Result<Self, BrokerError> {
        self.native_read = Some(NativeRead::prepare(resources)?);
        Ok(self)
    }

    pub async fn handle<E: CapabilityEffect>(
        &mut self,
        method: &str,
        params: Value,
        effect: &mut E,
    ) -> Result<Value, BrokerError> {
        let capability = capability(method).ok_or(BrokerError::Invalid("unknown host method"))?;
        let declared = self
            .manifest
            .capabilities
            .iter()
            .find(|c| {
                serde_json::to_value(c.name)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .as_deref()
                    == Some(capability)
            })
            .ok_or_else(|| {
                AuthorityError::Denied(format!("plugin did not declare {capability}"))
            })?;
        self.authority.granted(capability)?;
        let scopes: Vec<String> = declared
            .scopes
            .iter()
            .filter_map(|s| {
                serde_json::to_value(s)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
            })
            .collect();
        let p = params
            .as_object()
            .ok_or(BrokerError::Invalid("object required"))?;
        let field = |name| {
            p.get(name)
                .and_then(Value::as_str)
                .ok_or(BrokerError::Invalid("missing string field"))
        };
        let mut forwarded = params.clone();
        match method {
            "capability.fs.list" => {
                let dir = field("dir")?;
                self.authority.read_directory(dir)?;
                if !self.scope_roots.declares_directory(&scopes, dir)? {
                    return Err(AuthorityError::Denied("undeclared read directory".into()).into());
                }
                let pattern = field("glob")?;
                if pattern.is_empty()
                    || pattern.len() > 4096
                    || pattern.starts_with('/')
                    || pattern.contains('\0')
                    || pattern
                        .split(['/', '\\'])
                        .any(|part| part == "." || part == "..")
                {
                    return Err(BrokerError::Invalid("read glob"));
                }
                if p.get("limit").is_some_and(|value| {
                    value
                        .as_u64()
                        .is_none_or(|limit| !(1..=1000).contains(&limit))
                }) {
                    return Err(BrokerError::Invalid("list limit"));
                }
            }
            "capability.fs.read" | "capability.fs.stat" | "capability.fs.readRange" => {
                let path = field("path")?;
                self.authority.read(path)?;
                if !self.scope_roots.declares_path(&scopes, path)? {
                    return Err(AuthorityError::Denied("undeclared read scope".into()).into());
                }
            }
            "capability.fs.write" | "capability.fs.mkdir" | "capability.fs.remove" => {
                let path = field("path")?;
                let op = method.rsplit('.').next().unwrap_or_default();
                self.authority.write(path, op)?;
                if !self.scope_roots.declares_path(&scopes, path)? {
                    return Err(AuthorityError::Denied("undeclared write scope".into()).into());
                }
                if method == "capability.fs.write"
                    && p.get("mode")
                        .is_some_and(|mode| mode.as_u64() != Some(0o600))
                {
                    return Err(BrokerError::Invalid("write mode"));
                }
            }
            "capability.fs.beginWrite" => {
                self.feature("fileWriteChunks")?;
                let path = field("path")?.to_string();
                self.authority.write(&path, "write")?;
                if !self.scope_roots.declares_path(&scopes, &path)? {
                    return Err(AuthorityError::Denied("undeclared write scope".into()).into());
                }
                let size = p
                    .get("bytes")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("bytes"))?;
                let size = usize::try_from(size).map_err(|_| BrokerError::Invalid("bytes"))?;
                let mode = p.get("mode").map(|mode| mode.as_u64());
                if mode.is_some_and(|mode| mode != Some(0o600)) {
                    return Err(BrokerError::Invalid("write mode"));
                }
                let handle = self
                    .transfers
                    .begin(TransferKind::FileWrite, size)
                    .map_err(|_| BrokerError::Invalid("transfer bounds"))?;
                self.file_write = Some((handle.clone(), path, mode.flatten()));
                return Ok(json!({"handle":handle}));
            }
            "capability.fs.writeChunk" => {
                self.feature("fileWriteChunks")?;
                let bytes = self
                    .transfers
                    .append(
                        TransferKind::FileWrite,
                        field("handle")?,
                        usize::try_from(
                            p.get("offset")
                                .and_then(Value::as_u64)
                                .ok_or(BrokerError::Invalid("offset"))?,
                        )
                        .map_err(|_| BrokerError::Invalid("offset"))?,
                        field("base64")?,
                    )
                    .map_err(|_| BrokerError::Invalid("chunk"))?;
                return Ok(json!({"bytes":bytes}));
            }
            "capability.fs.commitWrite" => {
                self.feature("fileWriteChunks")?;
                let handle = field("handle")?;
                let (path, mode) = self
                    .file_write
                    .as_ref()
                    .filter(|(h, _, _)| h == handle)
                    .map(|(_, p, mode)| (p.clone(), *mode))
                    .ok_or_else(|| AuthorityError::Denied("file write handle".into()))?;
                self.authority.write(&path, "write")?;
                let bytes = self
                    .transfers
                    .consume(TransferKind::FileWrite, handle)
                    .map_err(|_| BrokerError::Invalid("incomplete file"))?;
                let text =
                    String::from_utf8(bytes).map_err(|_| BrokerError::Invalid("UTF-8 file"))?;
                forwarded = json!({"path":path,"text":text});
                if let Some(mode) = mode {
                    forwarded["mode"] = json!(mode);
                }
                self.file_write = None;
            }
            "capability.fs.releaseWrite" => {
                self.feature("fileWriteChunks")?;
                self.transfers
                    .release(TransferKind::FileWrite, field("handle")?)
                    .map_err(|_| BrokerError::Invalid("handle"))?;
                self.file_write = None;
                return Ok(json!({"ok":true}));
            }
            "capability.process.spawn" => {
                let argv = p
                    .get("argv")
                    .and_then(Value::as_array)
                    .ok_or(BrokerError::Invalid("argv"))?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .ok_or(BrokerError::Invalid("argv"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let ms = p
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("timeoutMs"))?;
                let issued = self.authority.command(
                    &argv,
                    ms,
                    p.get("cwd").and_then(Value::as_str),
                    p.get("stdin").and_then(Value::as_str),
                )?;
                if p.get("env").cloned().unwrap_or_else(|| json!({})) != json!(issued.env) {
                    return Err(AuthorityError::Denied(
                        "command environment was not issued".into(),
                    )
                    .into());
                }
                if !scopes
                    .iter()
                    .any(|s| argv.first().is_some_and(|arg| arg == s))
                {
                    return Err(AuthorityError::Denied("undeclared command scope".into()).into());
                }
            }
            "capability.net.http" => {
                let url =
                    url::Url::parse(field("url")?).map_err(|_| BrokerError::Invalid("url"))?;
                if !["http", "https"].contains(&url.scheme())
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err(BrokerError::Invalid("HTTP URL"));
                }
                let method = field("method")?;
                if !["GET", "POST", "PUT", "DELETE"].contains(&method) {
                    return Err(BrokerError::Invalid("HTTP method"));
                }
                p.get("timeoutMs")
                    .and_then(Value::as_u64)
                    .filter(|ms| (1..=120_000).contains(ms))
                    .ok_or(BrokerError::Invalid("HTTP timeoutMs"))?;
                if p.keys().any(|key| {
                    ![
                        "url",
                        "method",
                        "headers",
                        "body",
                        "timeoutMs",
                        "authorization",
                    ]
                    .contains(&key.as_str())
                }) {
                    return Err(BrokerError::Invalid("HTTP request field"));
                }
                if p.get("headers").is_some_and(|headers| {
                    headers.as_object().is_none_or(|entries| {
                        entries.iter().any(|(name, value)| {
                            !valid_http_header_name(name)
                                || value.as_str().is_none_or(|v| !valid_http_header_value(v))
                        })
                    })
                }) {
                    return Err(BrokerError::Invalid("HTTP headers"));
                }
                self.authority.http_destination(
                    &url,
                    &scopes,
                    self.explicit_http_wildcard_grant,
                )?;
                if let Some(auth) = p.get("authorization") {
                    let fields = auth
                        .as_object()
                        .ok_or(BrokerError::Invalid("HTTP authorization"))?;
                    if fields
                        .keys()
                        .any(|key| !["secretRef", "scheme"].contains(&key.as_str()))
                        || fields
                            .get("scheme")
                            .is_some_and(|scheme| !scheme.is_string())
                    {
                        return Err(BrokerError::Invalid("HTTP authorization"));
                    }
                    let secret = fields
                        .get("secretRef")
                        .and_then(Value::as_str)
                        .ok_or(BrokerError::Invalid("HTTP secret reference"))?;
                    if !valid_http_secret_ref(secret) {
                        return Err(BrokerError::Invalid("HTTP secret reference"));
                    }
                    if fields
                        .get("scheme")
                        .and_then(Value::as_str)
                        .is_some_and(|scheme| {
                            !valid_http_header_value(&format!("{scheme} placeholder"))
                        })
                    {
                        return Err(BrokerError::Invalid("HTTP authorization scheme"));
                    }
                    if self.authority.http_origins().is_none() {
                        return Err(AuthorityError::Denied(
                            "credentials require issued HTTP origins".into(),
                        )
                        .into());
                    }
                    self.authority.secret_alias(secret)?;
                }
                if let Some(body) = p.get("body") {
                    if let Some(handle) = body.get("handle").and_then(Value::as_str) {
                        if body.as_object().is_none_or(|obj| obj.len() != 1)
                            || handle.is_empty()
                            || handle.len() > 256
                        {
                            return Err(BrokerError::Invalid("HTTP upload handle"));
                        }
                        self.feature("httpBodyChunks")?;
                        let bytes = self
                            .transfers
                            .consume(TransferKind::HttpUpload, handle)
                            .map_err(|_| BrokerError::Invalid("HTTP upload"))?;
                        let text = String::from_utf8(bytes)
                            .map_err(|_| BrokerError::Invalid("HTTP body UTF-8"))?;
                        forwarded["body"] = json!(text);
                    } else if body.as_str().is_none_or(|s| s.len() > 4 * 1024 * 1024) {
                        return Err(BrokerError::Invalid("HTTP body"));
                    }
                }
            }
            "capability.net.http.body.begin" => {
                self.feature("httpBodyChunks")?;
                let size = p
                    .get("bytes")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("bytes"))?;
                let size = usize::try_from(size).map_err(|_| BrokerError::Invalid("bytes"))?;
                let handle = self
                    .transfers
                    .begin(TransferKind::HttpUpload, size)
                    .map_err(|_| BrokerError::Invalid("transfer bounds"))?;
                return Ok(json!({"handle":handle}));
            }
            "capability.net.http.body.stageChunk" => {
                self.feature("httpBodyChunks")?;
                let offset = p
                    .get("offset")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("offset"))?;
                let offset = usize::try_from(offset).map_err(|_| BrokerError::Invalid("offset"))?;
                let bytes = self
                    .transfers
                    .append(
                        TransferKind::HttpUpload,
                        field("handle")?,
                        offset,
                        field("base64")?,
                    )
                    .map_err(|_| BrokerError::Invalid("HTTP chunk"))?;
                return Ok(json!({"bytes":bytes}));
            }
            "capability.net.http.body.readChunk" => {
                self.feature("httpBodyChunks")?;
                let offset = p
                    .get("offset")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("offset"))?;
                let length = p
                    .get("length")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("length"))?;
                let data = self
                    .transfers
                    .read(
                        TransferKind::HttpResponse,
                        field("handle")?,
                        usize::try_from(offset).map_err(|_| BrokerError::Invalid("offset"))?,
                        usize::try_from(length).map_err(|_| BrokerError::Invalid("length"))?,
                    )
                    .map_err(|_| BrokerError::Invalid("response handle"))?;
                return Ok(json!({"base64":data}));
            }
            "capability.net.http.body.release" => {
                self.feature("httpBodyChunks")?;
                let handle = field("handle")?;
                self.transfers
                    .release(TransferKind::HttpUpload, handle)
                    .or_else(|_| self.transfers.release(TransferKind::HttpResponse, handle))
                    .map_err(|_| BrokerError::Invalid("HTTP handle"))?;
                return Ok(json!({"ok":true}));
            }
            "capability.identity.sign" => {
                let purpose = field("purpose")?;
                if !scopes.iter().any(|s| s == purpose) {
                    return Err(
                        AuthorityError::Denied("signing purpose was not declared".into()).into(),
                    );
                }
                let encoded = field("payload")?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| BrokerError::Invalid("base64"))?;
                if encoded.len() > 87_384 || STANDARD.encode(&bytes) != encoded {
                    return Err(BrokerError::Invalid("canonical base64"));
                }
            }
            "capability.secrets.check" | "capability.secrets.resolve" => {
                self.authority.secret_alias(field("ref")?)?;
            }
            "capability.worktree.createOrReuse" => {
                let task = field("taskId")?;
                let attempt = p
                    .get("attempt")
                    .and_then(Value::as_u64)
                    .ok_or(BrokerError::Invalid("attempt"))?;
                let sha = field("baseSha")?;
                self.authority.consume_worktree(task, attempt, sha)?;
            }
            "capability.worktree.inspect" | "capability.worktree.resolveBase" => {
                self.authority.worktree(
                    field("taskId")?,
                    p.get("attempt")
                        .and_then(Value::as_u64)
                        .ok_or(BrokerError::Invalid("attempt"))?,
                )?;
            }
            "capability.hosts.open" => {
                let handle = self
                    .hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?
                    .open(&self.authority, field("alias")?)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                return Ok(json!({"session":handle}));
            }
            "capability.hosts.run" => {
                let deadline = self.method_deadline(method);
                let session = field("session")?;
                let hosts = self
                    .hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?;
                let snap = hosts
                    .snapshot(session)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?
                    .clone();
                let current = effect
                    .provider_snapshot(&snap.alias)
                    .ok_or(BrokerError::Invalid("provider unavailable"))?;
                let request = crate::HostOperationResource {
                    alias: snap.alias.clone(),
                    host_fingerprint: snap.host_fingerprint.clone(),
                    script: field("script")?.into(),
                    args: p
                        .get("args")
                        .and_then(Value::as_array)
                        .ok_or(BrokerError::Invalid("args"))?
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .ok_or(BrokerError::Invalid("arg"))
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                    timeout_ms: p
                        .get("timeoutMs")
                        .and_then(Value::as_u64)
                        .ok_or(BrokerError::Invalid("timeout"))?,
                    max_bytes: p
                        .get("maxBytes")
                        .and_then(Value::as_u64)
                        .ok_or(BrokerError::Invalid("bytes"))?,
                };
                hosts
                    .run(&mut self.authority, session, &current, &request)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                let result = timeout_at(deadline.into(), effect.call(method, forwarded)).await;
                let result = match result {
                    Ok(value) => value,
                    Err(_) => {
                        hosts.close(session).ok();
                        self.revoke();
                        return Err(BrokerError::Timeout);
                    }
                };
                hosts
                    .finish(session)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                self.authority.active()?;
                if effect.provider_snapshot(&snap.alias).as_ref() != Some(&snap) {
                    hosts.close(session).ok();
                    return Err(BrokerError::HostLease("provider changed".into()));
                }
                return result;
            }
            "capability.hosts.close" => {
                self.hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?
                    .close(field("session")?)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                return Ok(json!({"ok":true}));
            }
            _ => {
                return Err(
                    AuthorityError::Denied("capability broker is not implemented".into()).into(),
                );
            }
        }
        self.authority.active()?;
        if method == "capability.fs.list"
            && let Some(native) = &self.native_read
        {
            let result = native.list(
                &forwarded,
                &scopes,
                &self.scope_roots,
                &self.authority,
                self.method_deadline(method),
            );
            if matches!(result, Err(BrokerError::Timeout)) {
                self.revoke();
            }
            let result = result?;
            self.authority.active()?;
            return Ok(result);
        }
        if matches!(
            method,
            "capability.fs.read" | "capability.fs.stat" | "capability.fs.readRange"
        ) && let Some(native) = &mut self.native_read
        {
            let result = native.answer(method, &forwarded)?;
            self.authority.active()?;
            return Ok(result);
        }
        let method_deadline = self.method_deadline(method);
        let requested_deadline = if method == "capability.net.http" {
            p.get("timeoutMs")
                .and_then(Value::as_u64)
                .map(|ms| Instant::now() + Duration::from_millis(ms))
        } else {
            None
        };
        let deadline =
            requested_deadline.map_or(method_deadline, |requested| requested.min(method_deadline));
        let mut result = match timeout_at(deadline.into(), effect.call(method, forwarded)).await {
            Ok(value) => value?,
            Err(_) => {
                if requested_deadline.is_none_or(|requested| requested >= method_deadline) {
                    self.revoke();
                }
                return Err(BrokerError::Timeout);
            }
        };
        self.authority.active()?;
        if method == "capability.net.http"
            && serde_json::to_vec(&result)
                .is_ok_and(|bytes| bytes.len() + 1 > crate::MAX_LINE_BYTES)
        {
            self.feature("httpBodyChunks")?;
            let body = result
                .get("body")
                .and_then(Value::as_str)
                .ok_or(BrokerError::Invalid("HTTP response body"))?;
            let handle = self
                .transfers
                .publish(TransferKind::HttpResponse, body.as_bytes())
                .map_err(|_| BrokerError::Invalid("HTTP response bounds"))?;
            result["body"] = json!({"handle":handle,"bytes":body.len()});
            if serde_json::to_vec(&result)
                .is_ok_and(|bytes| bytes.len() + 1 > crate::MAX_LINE_BYTES)
            {
                return Err(BrokerError::Invalid("HTTP response envelope"));
            }
        }
        Ok(result)
    }
    fn feature(&self, feature: &str) -> Result<(), BrokerError> {
        if self.features.iter().any(|f| f == feature) {
            Ok(())
        } else {
            Err(AuthorityError::Denied(format!("{feature} was not negotiated")).into())
        }
    }
    fn method_deadline(&self, method: &str) -> Instant {
        let ms = match method {
            "capability.identity.sign" => 15_000,
            "capability.net.http" => 125_000,
            "capability.hosts.run" => 120_000,
            "capability.fs.read"
            | "capability.fs.list"
            | "capability.fs.stat"
            | "capability.fs.readRange" => 5_000,
            "capability.fs.write"
            | "capability.fs.mkdir"
            | "capability.fs.remove"
            | "capability.fs.commitWrite" => 10_000,
            "capability.worktree.createOrReuse" => 70_000,
            "capability.worktree.resolveBase" => 100_000,
            "capability.worktree.inspect" => 15_000,
            "capability.process.spawn" => 0,
            _ => 5_000,
        };
        if ms == 0 {
            self.authority.deadline()
        } else {
            self.authority
                .deadline()
                .min(Instant::now() + Duration::from_millis(ms))
        }
    }
}

fn valid_http_secret_ref(value: &str) -> bool {
    let (kind, name) = if let Some(name) = value.strip_prefix("endpoint/") {
        if name.is_empty()
            || !name
                .bytes()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            || !name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return false;
        }
        return true;
    } else if let Some((kind, name)) = value.split_once(':') {
        (kind, name)
    } else {
        return false;
    };
    ["env", "secrets", "endpoint"].contains(&kind)
        && !name.is_empty()
        && name
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

fn valid_http_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn valid_http_header_value(value: &str) -> bool {
    !value.bytes().any(|c| c == 0 || c == b'\r' || c == b'\n')
}

fn capability(method: &str) -> Option<&'static str> {
    match method {
        "capability.fs.read"
        | "capability.fs.list"
        | "capability.fs.stat"
        | "capability.fs.readRange" => Some("fs.read"),
        "capability.fs.write"
        | "capability.fs.mkdir"
        | "capability.fs.remove"
        | "capability.fs.beginWrite"
        | "capability.fs.writeChunk"
        | "capability.fs.commitWrite"
        | "capability.fs.releaseWrite" => Some("fs.write"),
        "capability.process.spawn"
        | "capability.process.outputChunk"
        | "capability.process.startRun"
        | "capability.process.stopRun"
        | "capability.process.inspectRun"
        | "capability.process.claimRun"
        | "capability.process.pollRun"
        | "capability.process.readRunOutput"
        | "capability.process.completeReportedRun"
        | "capability.process.stageBundle" => Some("process.spawn"),
        "capability.net.http" => Some("net.http"),
        "capability.identity.sign" => Some("identity.sign"),
        "capability.secrets.check" | "capability.secrets.resolve" => Some("secrets.resolve"),
        "capability.config.get" => Some("config.get"),
        "capability.log" => Some("log"),
        "capability.worktree.inspect"
        | "capability.worktree.resolveBase"
        | "capability.worktree.createOrReuse" => Some("worktree"),
        _ if method.starts_with("capability.hosts.") => Some("hosts"),
        _ if method.starts_with("capability.process.duplex.") => Some("process.spawn"),
        _ if method.starts_with("capability.net.http.body.") => Some("net.http"),
        _ if method.starts_with("capability.net.p2p.") => Some("net.p2p"),
        _ if method.starts_with("capability.orca.") => Some("orca"),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
