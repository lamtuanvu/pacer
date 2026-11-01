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
    file_write: Option<(String, String)>,
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
                let handle = self
                    .transfers
                    .begin(TransferKind::FileWrite, size)
                    .map_err(|_| BrokerError::Invalid("transfer bounds"))?;
                self.file_write = Some((handle.clone(), path));
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
                let path = self
                    .file_write
                    .as_ref()
                    .filter(|(h, _)| h == handle)
                    .map(|(_, p)| p.clone())
                    .ok_or_else(|| AuthorityError::Denied("file write handle".into()))?;
                self.authority.write(&path, "write")?;
                let bytes = self
                    .transfers
                    .consume(TransferKind::FileWrite, handle)
                    .map_err(|_| BrokerError::Invalid("incomplete file"))?;
                let text =
                    String::from_utf8(bytes).map_err(|_| BrokerError::Invalid("UTF-8 file"))?;
                forwarded = json!({"path":path,"text":text});
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
            "capability.fs.read" | "capability.fs.stat" | "capability.fs.readRange" => 5_000,
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
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::{CallResources, CommandResource, ReadResource, parse_manifest};
    use std::time::{Duration, Instant};

    fn http_broker(scopes: &[&str], hosts: &[&str], origins: &[&str]) -> CapabilityBroker {
        let manifest = parse_manifest(
            json!({"id":"fx-http","version":"1.0.0","publisher":"fixture","host":">=1.2.0",
            "capabilities":[{"name":"net.http","scopes":scopes}]}),
        )
        .unwrap();
        let http = if origins.is_empty() {
            json!({"hosts":hosts})
        } else {
            json!({"hosts":hosts,"origins":origins})
        };
        let resources: CallResources = serde_json::from_value(json!({"http":http})).unwrap();
        let authority = CallAuthority::new(
            resources,
            ["net.http".into()],
            Instant::now() + Duration::from_secs(2),
        );
        CapabilityBroker::new(manifest, authority, vec![])
    }

    #[tokio::test]
    async fn http_requires_issued_origin_and_exact_host_admission() {
        let mut b = http_broker(
            &["example.test"],
            &["example.test"],
            &["https://example.test"],
        );
        let mut e = Echo { calls: 0 };
        for url in [
            "http://example.test/",
            "https://example.test:444/",
            "https://example.test@other.test/",
            "https://example.test.evil/",
            "https://example.test/redirect",
        ] {
            let denied = !url.contains("redirect");
            let result = b
                .handle(
                    "capability.net.http",
                    json!({"url":url,"method":"GET","timeoutMs":1000}),
                    &mut e,
                )
                .await;
            if denied {
                assert!(result.is_err(), "{url}");
            } else {
                assert!(result.is_ok(), "{url}");
            }
        }
        assert!(b.handle("capability.net.http", json!({"url":"https://other.test/","method":"GET","timeoutMs":1000,"headers":{"Host":"example.test"}}), &mut e).await.is_err());
        assert!(
            b.handle(
                "capability.net.http",
                json!({"url":"https://example.test:443/","method":"GET","timeoutMs":1000}),
                &mut e
            )
            .await
            .is_ok()
        );
        assert_eq!(e.calls, 2);
    }

    #[tokio::test]
    async fn http_request_bounds_precede_effect_and_limit_its_deadline() {
        let mut b = http_broker(
            &["example.test"],
            &["example.test"],
            &["https://example.test"],
        );
        let mut e = Echo { calls: 0 };
        for params in [
            json!({"url":"https://example.test/","method":"TRACE","timeoutMs":1000}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":0}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":120001}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":1.5}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"extra":true}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"authorization":{"secretRef":"bad ref"}}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"headers":{"bad header":"value"}}),
            json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"headers":{"X-Test":"ok\r\nHost: evil.test"}}),
        ] {
            assert!(
                b.handle("capability.net.http", params, &mut e)
                    .await
                    .is_err()
            );
        }
        assert_eq!(e.calls, 0);
        struct Slow;
        impl CapabilityEffect for Slow {
            async fn call(&mut self, _method: &str, _params: Value) -> Result<Value, BrokerError> {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(json!({"ok":true}))
            }
        }
        assert!(matches!(
            b.handle(
                "capability.net.http",
                json!({"url":"https://example.test/","method":"GET","timeoutMs":1}),
                &mut Slow
            )
            .await,
            Err(BrokerError::Timeout)
        ));
        assert!(b.authority().active().is_ok());
    }

    #[tokio::test]
    async fn http_wildcards_follow_ts_subdomain_and_explicit_grant_rules() {
        let mut b = http_broker(&["*.example.test"], &["*.example.test"], &[]);
        let mut e = Echo { calls: 0 };
        for url in [
            "https://example.test/",
            "https://badexample.test/",
            "https://a.example.test.evil/",
        ] {
            assert!(
                b.handle(
                    "capability.net.http",
                    json!({"url":url,"method":"GET","timeoutMs":1000}),
                    &mut e
                )
                .await
                .is_err()
            );
        }
        let result = b
            .handle(
                "capability.net.http",
                json!({"url":"https://a.example.test/","method":"GET","timeoutMs":1000}),
                &mut e,
            )
            .await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(e.calls, 1);
        let mut wildcard = http_broker(&["*"], &["*"], &[]);
        assert!(
            wildcard
                .handle(
                    "capability.net.http",
                    json!({"url":"https://other.test/","method":"GET","timeoutMs":1000}),
                    &mut e
                )
                .await
                .is_err()
        );
        let mut wildcard = http_broker(&["*"], &["*"], &[]).with_explicit_http_wildcard_grant(true);
        assert!(
            wildcard
                .handle(
                    "capability.net.http",
                    json!({"url":"https://other.test/","method":"GET","timeoutMs":1000}),
                    &mut e
                )
                .await
                .is_ok()
        );
    }

    struct Echo {
        calls: usize,
    }
    impl CapabilityEffect for Echo {
        async fn call(&mut self, _method: &str, params: Value) -> Result<Value, BrokerError> {
            self.calls += 1;
            Ok(params)
        }
    }
    fn broker(ms: u64) -> CapabilityBroker {
        let manifest = parse_manifest(
            json!({"id":"fx-broker","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"fs.read","scopes":["/tmp/issued"]},
                {"name":"process.spawn","scopes":["echo"]},
                {"name":"identity.sign","scopes":["conformance"]},
                {"name":"fs.write","scopes":["/tmp/issued"]}]}),
        )
        .unwrap();
        let resources = CallResources {
            reads: vec![ReadResource {
                path: "/tmp/issued".into(),
                kind: "file".into(),
            }],
            commands: vec![CommandResource {
                argv: vec!["echo".into(), "ok".into()],
                timeout_ms: 1000,
                stdin: None,
                cwd: None,
                env: Default::default(),
            }],
            writes: vec![crate::WriteResource {
                path: "/tmp/issued".into(),
                kind: "file".into(),
                operations: vec!["write".into()],
            }],
            ..Default::default()
        };
        let authority = CallAuthority::new(
            resources,
            [
                "fs.read".into(),
                "process.spawn".into(),
                "identity.sign".into(),
                "fs.write".into(),
            ],
            Instant::now() + Duration::from_millis(ms),
        );
        CapabilityBroker::new(manifest, authority, vec!["fileWriteChunks".into()])
    }
    #[tokio::test]
    async fn denies_adversarial_paths_and_commands_before_effect() {
        let mut b = broker(1000);
        let mut e = Echo { calls: 0 };
        assert!(
            b.handle(
                "capability.fs.read",
                json!({"path":"/tmp/../tmp/issued"}),
                &mut e
            )
            .await
            .is_err()
        );
        assert!(
            b.handle("capability.fs.read", json!({"path":"/tmp/other"}), &mut e)
                .await
                .is_err()
        );
        assert!(
            b.handle(
                "capability.process.spawn",
                json!({"argv":["echo","changed"],"timeoutMs":1000}),
                &mut e
            )
            .await
            .is_err()
        );
        assert!(
            b.handle(
                "capability.process.spawn",
                json!({"argv":["echo","ok"],"timeoutMs":1001}),
                &mut e
            )
            .await
            .is_err()
        );
        assert_eq!(e.calls, 0);
        assert!(
            b.handle("capability.fs.read", json!({"path":"/tmp/issued"}), &mut e)
                .await
                .is_ok()
        );
        assert_eq!(e.calls, 1);
    }
    #[tokio::test]
    async fn expiry_and_canonical_signing_precede_effect() {
        let mut b = broker(1);
        let mut e = Echo { calls: 0 };
        assert!(
            b.handle(
                "capability.identity.sign",
                json!({"purpose":"other","payload":"YQ=="}),
                &mut e
            )
            .await
            .is_err()
        );
        assert!(
            b.handle(
                "capability.identity.sign",
                json!({"purpose":"conformance","payload":"YQ="}),
                &mut e
            )
            .await
            .is_err()
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(
            b.handle("capability.fs.read", json!({"path":"/tmp/issued"}), &mut e)
                .await
                .is_err()
        );
        assert_eq!(e.calls, 0);
    }
    #[tokio::test]
    async fn deadline_revokes_in_flight_effect() {
        struct Slow;
        impl CapabilityEffect for Slow {
            async fn call(&mut self, _method: &str, _params: Value) -> Result<Value, BrokerError> {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(json!({"ok":true}))
            }
        }
        let mut b = broker(5);
        assert!(matches!(
            b.handle(
                "capability.fs.read",
                json!({"path":"/tmp/issued"}),
                &mut Slow
            )
            .await,
            Err(BrokerError::Timeout)
        ));
        assert!(matches!(
            b.authority().active(),
            Err(AuthorityError::Expired)
        ));
    }
    #[tokio::test]
    async fn file_transfer_rejects_cross_handle_and_incomplete_commit() {
        let mut b = broker(1000);
        let mut e = Echo { calls: 0 };
        let h = b
            .handle(
                "capability.fs.beginWrite",
                json!({"path":"/tmp/issued","bytes":3}),
                &mut e,
            )
            .await
            .unwrap();
        let handle = h["handle"].as_str().unwrap();
        assert!(
            b.handle(
                "capability.fs.writeChunk",
                json!({"handle":"foreign","offset":0,"base64":"YWJj"}),
                &mut e
            )
            .await
            .is_err()
        );
        assert!(
            b.handle(
                "capability.fs.commitWrite",
                json!({"handle":handle}),
                &mut e
            )
            .await
            .is_err()
        );
        assert!(
            b.handle(
                "capability.fs.writeChunk",
                json!({"handle":handle,"offset":0,"base64":"YWJj"}),
                &mut e
            )
            .await
            .is_ok()
        );
        assert!(
            b.handle(
                "capability.fs.commitWrite",
                json!({"handle":handle}),
                &mut e
            )
            .await
            .is_ok()
        );
        assert_eq!(e.calls, 1);
    }
    #[tokio::test]
    async fn http_upload_is_owner_local_and_requires_captured_host() {
        let manifest = parse_manifest(
            json!({"id":"fx-http","version":"1.0.0","publisher":"fixture","host":">=1.2.0",
            "capabilities":[{"name":"net.http","scopes":["example.test"]}]}),
        )
        .unwrap();
        let resources: CallResources =
            serde_json::from_value(json!({"http":{"hosts":["example.test"]}})).unwrap();
        let authority = CallAuthority::new(
            resources,
            ["net.http".into()],
            Instant::now() + Duration::from_secs(1),
        );
        let mut b = CapabilityBroker::new(manifest, authority, vec!["httpBodyChunks".into()]);
        let mut e = Echo { calls: 0 };
        let handle = b
            .handle("capability.net.http.body.begin", json!({"bytes":3}), &mut e)
            .await
            .unwrap()["handle"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(b.handle("capability.net.http",json!({"url":"https://other.test/","method":"POST","timeoutMs":1000,"body":{"handle":handle}}),&mut e).await.is_err());
        assert_eq!(e.calls, 0);
        assert!(
            b.handle(
                "capability.net.http.body.stageChunk",
                json!({"handle":handle,"offset":0,"base64":"YWJj"}),
                &mut e
            )
            .await
            .is_ok()
        );
        let value=b.handle("capability.net.http",json!({"url":"https://example.test/","method":"POST","timeoutMs":1000,"body":{"handle":handle}}),&mut e).await.unwrap();
        assert_eq!(value["body"], "abc");
        assert_eq!(e.calls, 1);
    }

    #[tokio::test]
    async fn native_exact_file_read_does_not_invoke_adapter() {
        let root = std::env::temp_dir().join(format!("pacer-broker-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("usage.json");
        std::fs::write(&path, "usage").unwrap();
        let path = path.to_str().unwrap().to_string();
        let manifest = parse_manifest(
            json!({"id":"fx-read","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"fs.read","scopes":[path]}]}),
        )
        .unwrap();
        let resources = CallResources {
            reads: vec![ReadResource {
                path: path.clone(),
                kind: "file".into(),
            }],
            ..Default::default()
        };
        let authority = CallAuthority::new(
            resources.clone(),
            ["fs.read".into()],
            Instant::now() + Duration::from_secs(1),
        );
        let mut broker = CapabilityBroker::new(manifest, authority, vec![])
            .with_native_read(&resources.reads)
            .unwrap();
        let mut echo = Echo { calls: 0 };
        assert_eq!(
            broker
                .handle("capability.fs.read", json!({"path":path}), &mut echo)
                .await
                .unwrap()["text"],
            "usage"
        );
        assert_eq!(echo.calls, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
