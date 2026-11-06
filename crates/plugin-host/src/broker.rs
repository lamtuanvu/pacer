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
    #[error("Policy hash key cannot be accessed safely")]
    PolicyKey,
    #[error("{0}")]
    PolicyVeto(String),
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
    /// Only a host-issued owner may admit lifecycle methods without a wire resource.
    fn owns_lifecycle(&self, _method: &str, _plugin_id: &str, _scopes: &[String]) -> bool {
        false
    }
    fn native_host_sessions(&self) -> bool {
        false
    }
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
    native_write: Option<crate::NativeWrite>,
    native_process: Option<crate::NativeProcess>,
    native_http: Option<crate::NativeHttp>,
    native_worktree: Option<crate::NativeWorktree>,
    native_duplex: Option<crate::NativeDuplex>,
    native_bundle: Option<crate::NativeBundle>,
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
            native_write: None,
            native_process: None,
            native_http: None,
            native_worktree: None,
            native_duplex: None,
            native_bundle: None,
            explicit_http_wildcard_grant: false,
        }
    }
    pub fn revoke(&mut self) {
        self.authority.revoke();
        self.transfers.revoke();
        self.file_write = None;
        self.native_write = None;
        self.native_process = None;
        self.native_http = None;
        self.native_worktree = None;
        self.native_duplex = None;
        self.native_bundle = None;
        if let Some(hosts) = &mut self.hosts {
            hosts.revoke();
        }
    }
    pub fn authority(&self) -> &CallAuthority {
        &self.authority
    }
    pub fn with_native_write(
        mut self,
        root: &std::path::Path,
        resources: &[crate::WriteResource],
    ) -> Result<Self, BrokerError> {
        self.native_write = Some(crate::NativeWrite::prepare(root, resources)?);
        Ok(self)
    }
    pub fn with_native_process(mut self, process: crate::NativeProcess) -> Self {
        self.native_process = Some(process);
        self
    }
    pub fn with_native_http(mut self, http: crate::NativeHttp) -> Self {
        self.native_http = Some(http);
        self
    }
    pub fn with_native_worktree(mut self, worktree: crate::NativeWorktree) -> Self {
        self.native_worktree = Some(worktree);
        self
    }
    pub fn with_native_duplex(mut self, duplex: crate::NativeDuplex) -> Self {
        self.native_duplex = Some(duplex);
        self
    }
    pub fn with_native_bundle(mut self, bundle: crate::NativeBundle) -> Self {
        self.native_bundle = Some(bundle);
        self
    }
    pub fn claim_native_bundle(
        &mut self,
        handle: &str,
    ) -> Result<crate::BundleTicket, BrokerError> {
        self.authority.active()?;
        self.native_bundle
            .as_mut()
            .ok_or(BrokerError::Invalid("bundle owner"))?
            .claim(handle)
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
        validate_request_fields(method, p)?;
        let field = |name| {
            p.get(name)
                .and_then(Value::as_str)
                .ok_or(BrokerError::Invalid("missing string field"))
        };
        let mut forwarded = params.clone();
        if matches!(
            method,
            "capability.identity.sign" | "capability.secrets.resolve"
        ) && let Some(object) = forwarded.as_object_mut()
        {
            object.retain(|key, _| match method {
                "capability.identity.sign" => ["purpose", "payload"].contains(&key.as_str()),
                _ => key == "ref",
            });
        }
        if method == "capability.fs.readRange"
            && let Some(expected) = forwarded.get_mut("expected").and_then(Value::as_object_mut)
        {
            expected.retain(|key, _| {
                ["size", "mtimeMs", "inode", "device", "mode"].contains(&key.as_str())
            });
        }
        match method {
            "capability.process.claimRun"
            | "capability.process.startRun"
            | "capability.process.stopRun"
            | "capability.process.inspectRun"
            | "capability.process.pollRun"
            | "capability.process.readRunOutput"
            | "capability.process.completeReportedRun"
            | "capability.hosts.prepareOwned"
            | "capability.hosts.claimOwned"
            | "capability.hosts.startOwned"
            | "capability.hosts.pollOwned"
            | "capability.hosts.readOwnedOutput"
            | "capability.hosts.stopOwned"
            | "capability.hosts.transferOwned" => {
                if !effect.owns_lifecycle(method, self.manifest.id.as_str(), &scopes) {
                    return Err(
                        AuthorityError::Denied("lifecycle owner was not issued".into()).into(),
                    );
                }
            }
            "capability.fs.list" => {
                let dir = field("dir")?;
                self.authority.read_directory(dir)?;
                let dir = crate::authority::normalize_path(dir);
                if !self.scope_roots.declares_directory(&scopes, &dir)? {
                    return Err(AuthorityError::Denied("undeclared read directory".into()).into());
                }
                forwarded["dir"] = json!(dir);
                let pattern = field("glob")?;
                if pattern.is_empty()
                    || crate::js_semantics::utf16_len(pattern) > 4096
                    || pattern.starts_with('/')
                    || pattern.contains('\0')
                    || pattern
                        .split(['/', '\\'])
                        .any(|part| part == "." || part == "..")
                {
                    return Err(BrokerError::Invalid("read glob"));
                }
                if p.get("limit").is_some_and(|value| {
                    crate::js_semantics::safe_u64(value)
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
                if method == "capability.fs.write"
                    && p.get("text")
                        .and_then(Value::as_str)
                        .is_none_or(|text| text.len() > 4 * 1024 * 1024)
                {
                    return Err(BrokerError::Invalid("write text"));
                }
                if p.get("recursive").is_some_and(|v| !v.is_boolean()) {
                    return Err(BrokerError::Invalid("recursive"));
                }
                let path = field("path")?;
                let op = method.rsplit('.').next().unwrap_or_default();
                self.authority.write(path, op)?;
                if !self.scope_roots.declares_path(&scopes, path)? {
                    return Err(AuthorityError::Denied("undeclared write scope".into()).into());
                }
                if method == "capability.fs.write"
                    && p.get("mode")
                        .is_some_and(|mode| crate::js_semantics::safe_u64(mode) != Some(0o600))
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
                if let Some(native) = &self.native_write {
                    native.check(&path, "write")?;
                }
                let size = p
                    .get("bytes")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|bytes| *bytes <= 4 * 1024 * 1024)
                    .ok_or(BrokerError::Invalid("bytes"))?;
                let size = usize::try_from(size).map_err(|_| BrokerError::Invalid("bytes"))?;
                let mode = p.get("mode").map(crate::js_semantics::safe_u64);
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
                                .and_then(crate::js_semantics::safe_u64)
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
                let handle = field("handle")?;
                self.transfers
                    .release(TransferKind::FileWrite, handle)
                    .map_err(|_| BrokerError::Invalid("handle"))?;
                if self
                    .file_write
                    .as_ref()
                    .is_some_and(|(h, _, _)| h == handle)
                {
                    self.file_write = None;
                }
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
                    .and_then(crate::js_semantics::safe_u64)
                    .ok_or(BrokerError::Invalid("timeoutMs"))?;
                let issued = self.authority.command(
                    &argv,
                    ms,
                    p.get("cwd").and_then(Value::as_str),
                    p.get("stdin").and_then(Value::as_str),
                )?;
                if !issued.matches(&params, ms) {
                    return Err(AuthorityError::Denied(
                        "command environment was not issued".into(),
                    )
                    .into());
                }
                if issued.secret_env.as_ref().is_some_and(|e| !e.is_empty()) {
                    self.authority.granted("secrets.resolve")?;
                }
                if !scopes
                    .iter()
                    .any(|s| argv.first().is_some_and(|arg| arg == s))
                {
                    return Err(AuthorityError::Denied("undeclared command scope".into()).into());
                }
            }
            "capability.process.outputChunk" => {
                let handle = field("handle")?;
                if handle.is_empty()
                    || crate::js_semantics::codepoint_len(handle) > 256
                    || p.get("offset")
                        .and_then(crate::js_semantics::safe_u64)
                        .is_none()
                    || p.get("length")
                        .and_then(crate::js_semantics::safe_u64)
                        .is_none_or(|n| n > 262_144)
                {
                    return Err(BrokerError::Invalid("output range"));
                }
            }
            "capability.process.stageBundle" => {
                if !scopes.iter().any(|s| s == "ssh") || self.native_bundle.is_none() {
                    return Err(
                        AuthorityError::Denied("bundle staging was not issued".into()).into(),
                    );
                }
            }
            _ if method.starts_with("capability.process.duplex.") => {
                if !scopes.iter().any(|s| s == "ssh") || self.native_duplex.is_none() {
                    return Err(AuthorityError::Denied("SSH duplex was not issued".into()).into());
                }
            }
            "capability.orca.status" => {}
            _ if method.starts_with("capability.orca.") => {
                let action = match method {
                    "capability.orca.stop" => Some("stop"),
                    "capability.orca.sessionState" => Some("inspect"),
                    _ => None,
                };
                let attempt = p
                    .get("attempt")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|n| *n > 0)
                    .ok_or(BrokerError::Invalid("Orca attempt"))?;
                self.authority.orca(
                    self.manifest.id.as_str(),
                    field("taskId")?,
                    attempt,
                    action,
                )?;
            }
            "capability.net.http" => {
                if self.transfers.has_pending(TransferKind::HttpResponse) {
                    return Err(BrokerError::Invalid(
                        "release the pending HTTP response first",
                    ));
                }
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
                    .and_then(crate::js_semantics::safe_u64)
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
                    if let Some(native) = &self.native_http {
                        if !native.has_binding(secret) {
                            return Err(AuthorityError::Denied(
                                "credential reference is not bound to this call".into(),
                            )
                            .into());
                        }
                    } else {
                        self.authority.secret_alias(secret)?;
                    }
                }
                if let Some(body) = p.get("body") {
                    if let Some(handle) = body.get("handle").and_then(Value::as_str) {
                        if body.as_object().is_none_or(|obj| obj.len() != 1)
                            || handle.is_empty()
                            || crate::js_semantics::codepoint_len(handle) > 256
                        {
                            return Err(BrokerError::Invalid("HTTP upload handle"));
                        }
                        self.feature("httpBodyChunks")?;
                        let text = self
                            .transfers
                            .consume_text(TransferKind::HttpUpload, handle)
                            .map_err(|_| BrokerError::Invalid("HTTP upload"))?;
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
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|bytes| *bytes <= 4 * 1024 * 1024)
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
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|offset| *offset <= 4 * 1024 * 1024)
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
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|offset| *offset <= 4 * 1024 * 1024)
                    .ok_or(BrokerError::Invalid("offset"))?;
                let length = p
                    .get("length")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|length| *length <= 256 * 1024)
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
                if !crate::valid_reference(field("ref")?) {
                    return Err(BrokerError::Invalid("secret reference"));
                }
                if method == "capability.secrets.check"
                    && let Some(native) = &self.native_http
                {
                    if !native.has_binding(field("ref")?) {
                        return Err(AuthorityError::Denied(
                            "credential reference is not bound to this call".into(),
                        )
                        .into());
                    }
                } else {
                    self.authority.secret_alias(field("ref")?)?;
                }
            }
            "capability.worktree.createOrReuse" => {
                validate_task_id(field("taskId")?)?;
                let task = field("taskId")?;
                let attempt = p
                    .get("attempt")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|attempt| *attempt > 0)
                    .ok_or(BrokerError::Invalid("attempt"))?;
                let sha = field("baseSha")?;
                if ![40, 64].contains(&sha.len())
                    || !sha
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(BrokerError::Invalid("baseSha"));
                }
                self.authority.consume_worktree(task, attempt, sha)?;
            }
            "capability.worktree.inspect" | "capability.worktree.resolveBase" => {
                validate_task_id(field("taskId")?)?;
                self.authority.worktree(
                    field("taskId")?,
                    p.get("attempt")
                        .and_then(crate::js_semantics::safe_u64)
                        .filter(|attempt| *attempt > 0)
                        .ok_or(BrokerError::Invalid("attempt"))?,
                )?;
            }
            "capability.hosts.open" => {
                let alias = field("alias")?;
                if !alias
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                    || !alias
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                {
                    return Err(BrokerError::Invalid("host alias"));
                }
                let handle = self
                    .hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?
                    .open(&self.authority, field("alias")?)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                if effect.native_host_sessions() {
                    let deadline = self.method_deadline(method);
                    let result = timeout_at(
                        deadline.into(),
                        effect.call(method, json!({"alias":field("alias")?,"session":handle})),
                    )
                    .await;
                    match result {
                        Ok(Ok(_)) => {}
                        Ok(Err(error)) => {
                            if let Some(hosts) = &mut self.hosts {
                                hosts.close(&handle).ok();
                            }
                            return Err(error);
                        }
                        Err(_) => {
                            self.revoke();
                            return Err(BrokerError::Timeout);
                        }
                    }
                }
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
                        .and_then(crate::js_semantics::safe_u64)
                        .filter(|timeout| (1..=120_000).contains(timeout))
                        .ok_or(BrokerError::Invalid("timeout"))?,
                    max_bytes: p
                        .get("maxBytes")
                        .and_then(crate::js_semantics::safe_u64)
                        .filter(|bytes| (1..=524_288).contains(bytes))
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
            "capability.hosts.fetch" => {
                let session = field("session")?;
                let timeout_ms = p
                    .get("timeoutMs")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|n| (1..=60000).contains(n))
                    .ok_or(BrokerError::Invalid("fetch timeout"))?;
                let max_bytes = p
                    .get("maxBytes")
                    .and_then(crate::js_semantics::safe_u64)
                    .filter(|n| (1..=50 * 1024 * 1024).contains(n))
                    .ok_or(BrokerError::Invalid("fetch bounds"))?;
                let hosts = self
                    .hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?;
                let snapshot = hosts
                    .snapshot(session)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?
                    .clone();
                let request = self
                    .authority
                    .host_fetch(&snapshot.alias, timeout_ms, max_bytes)?;
                let current = effect
                    .provider_snapshot(&snapshot.alias)
                    .ok_or(BrokerError::Invalid("no host provider"))?;
                hosts
                    .run(&mut self.authority, session, &current, &request)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                forwarded["script"] = json!("BUNDLE_OUT");
                forwarded["args"] = json!(request.args);
                let deadline = self
                    .authority
                    .deadline()
                    .min(Instant::now() + Duration::from_secs(120));
                let result = timeout_at(deadline.into(), effect.call(method, forwarded)).await;
                let hosts = self
                    .hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?;
                hosts
                    .finish(session)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                self.authority.active()?;
                return result.map_err(|_| BrokerError::Timeout)?;
            }
            "capability.hosts.close" => {
                self.hosts
                    .as_ref()
                    .ok_or(BrokerError::Invalid("no host provider"))?
                    .snapshot(field("session")?)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                if effect.native_host_sessions() {
                    effect.call(method, forwarded.clone()).await?;
                }
                self.hosts
                    .as_mut()
                    .ok_or(BrokerError::Invalid("no host provider"))?
                    .close(field("session")?)
                    .map_err(|e| BrokerError::HostLease(e.to_string()))?;
                return Ok(json!({"ok":true}));
            }
            "capability.log" => {
                let level = field("level")?;
                if !["debug", "info", "warn", "error"].contains(&level) {
                    return Err(BrokerError::Invalid("log level"));
                }
                let message = field("message")?;
                if message.is_empty() || crate::js_semantics::codepoint_len(message) > 4096 {
                    return Err(BrokerError::Invalid("log message"));
                }
            }
            "capability.config.get" => {}
            _ => {
                return Err(
                    AuthorityError::Denied("capability broker is not implemented".into()).into(),
                );
            }
        }
        self.authority.active()?;
        if method == "capability.process.stageBundle"
            && let Some(native) = &mut self.native_bundle
        {
            let result = native.stage(&forwarded, self.authority.deadline()).await?;
            self.authority.active()?;
            return Ok(result);
        }
        if method.starts_with("capability.process.duplex.")
            && let Some(native) = &mut self.native_duplex
        {
            let result = native
                .answer(method, &forwarded, self.authority.deadline())
                .await?;
            self.authority.active()?;
            return Ok(result);
        }
        if method.starts_with("capability.worktree.")
            && let Some(native) = &mut self.native_worktree
        {
            let result = native
                .answer(method, &forwarded, self.authority.deadline())
                .await?;
            self.authority.active()?;
            return Ok(result);
        }
        if matches!(method, "capability.net.http" | "capability.secrets.check")
            && let Some(native) = &mut self.native_http
        {
            let deadline = self.authority.deadline();
            let value = timeout_at(deadline.into(), async {
                if method == "capability.secrets.check" {
                    native
                        .secret_presence(
                            forwarded["ref"]
                                .as_str()
                                .ok_or(BrokerError::Invalid("secret reference"))?,
                        )
                        .await
                } else {
                    native.request(&forwarded).await
                }
            })
            .await;
            match value {
                Ok(value) => {
                    self.authority.active()?;
                    let mut result = value?;
                    if method == "capability.net.http"
                        && serde_json::to_vec(&result)
                            .is_ok_and(|bytes| bytes.len() + 1 > crate::MAX_LINE_BYTES)
                    {
                        self.feature("httpBodyChunks")?;
                        let body = result["body"]
                            .as_str()
                            .ok_or(BrokerError::Invalid("HTTP response body"))?;
                        let handle = self
                            .transfers
                            .publish(TransferKind::HttpResponse, body.as_bytes())
                            .map_err(|_| BrokerError::Invalid("HTTP response bounds"))?;
                        result["body"] = json!({"handle":handle,"bytes":body.len()});
                    }
                    return Ok(result);
                }
                Err(_) => {
                    self.revoke();
                    return Err(BrokerError::Timeout);
                }
            }
        }
        if let Some(native) = &mut self.native_process {
            if method == "capability.process.spawn" {
                let result = native.spawn(&forwarded, self.authority.deadline()).await?;
                self.authority.active()?;
                return Ok(result);
            }
            if method == "capability.process.outputChunk" {
                return native.output_chunk(&forwarded);
            }
        }
        if matches!(
            method,
            "capability.fs.write"
                | "capability.fs.mkdir"
                | "capability.fs.remove"
                | "capability.fs.commitWrite"
        ) && let Some(native) = &mut self.native_write
        {
            let op = if method == "capability.fs.commitWrite" {
                "capability.fs.write"
            } else {
                method
            };
            let result = native.answer(op, &forwarded)?;
            self.authority.active()?;
            return Ok(result);
        }
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
                .and_then(crate::js_semantics::safe_u64)
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
            "capability.hosts.prepareOwned" => 180_000,
            "capability.hosts.claimOwned" | "capability.hosts.readOwnedOutput" => 15_000,
            "capability.hosts.stopOwned" => 45_000,
            "capability.hosts.startOwned"
            | "capability.hosts.pollOwned"
            | "capability.hosts.transferOwned" => 120_000,
            "capability.process.startRun"
            | "capability.process.claimRun"
            | "capability.process.completeReportedRun" => 10_000,
            "capability.process.stopRun" => 30_000,
            "capability.hosts.run" => 120_000,
            "capability.hosts.open" => 30_000,
            "capability.hosts.close" => 10_000,
            "capability.secrets.check" => 2_000,
            "capability.process.stageBundle" => 70_000,
            "capability.orca.status" => 20_000,
            "capability.orca.prepare" | "capability.orca.place" | "capability.orca.finish" => {
                180_000
            }
            "capability.orca.start" => 300_000,
            "capability.orca.adopt" | "capability.orca.sessionState" => 60_000,
            "capability.orca.wait" => 0,
            _ if method.starts_with("capability.orca.") => 120_000,
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

fn validate_request_fields(
    method: &str,
    params: &serde_json::Map<String, Value>,
) -> Result<(), BrokerError> {
    let allowed: &[&str] = match method {
        "capability.fs.list" => &["dir", "glob", "limit"],
        "capability.fs.read" | "capability.fs.stat" | "capability.fs.mkdir" => &["path"],
        "capability.fs.readRange" => &["path", "offset", "length", "expected"],
        "capability.fs.write" => &["path", "text", "mode"],
        "capability.fs.remove" => &["path", "recursive"],
        "capability.fs.beginWrite" => &["path", "bytes", "mode"],
        "capability.fs.writeChunk" | "capability.net.http.body.stageChunk" => {
            &["handle", "offset", "base64"]
        }
        "capability.fs.commitWrite"
        | "capability.fs.releaseWrite"
        | "capability.net.http.body.release" => &["handle"],
        "capability.process.startRun" => &["task", "attempt", "runDir"],
        "capability.process.stopRun" | "capability.hosts.stopOwned" => {
            &["taskId", "attempt", "graceMs"]
        }
        "capability.process.claimRun"
        | "capability.process.inspectRun"
        | "capability.process.pollRun"
        | "capability.process.readRunOutput"
        | "capability.process.completeReportedRun"
        | "capability.hosts.prepareOwned"
        | "capability.hosts.claimOwned"
        | "capability.hosts.startOwned"
        | "capability.hosts.pollOwned"
        | "capability.hosts.readOwnedOutput"
        | "capability.hosts.transferOwned" => &["taskId", "attempt"],
        "capability.process.spawn" => &["argv", "timeoutMs", "cwd", "stdin", "env"],
        "capability.process.outputChunk" => &["handle", "offset", "length"],
        "capability.process.stageBundle" => &["argv", "timeoutMs", "maxBytes"],
        "capability.process.duplex.open" => &["argv", "timeoutMs"],
        "capability.process.duplex.read" => &["handle", "length", "timeoutMs", "pollMs"],
        "capability.process.duplex.write" => &["handle", "base64", "timeoutMs"],
        "capability.process.duplex.close" => &["handle", "graceful"],
        "capability.orca.status" => &[],
        "capability.orca.liveAnswer"
        | "capability.orca.prepare"
        | "capability.orca.place"
        | "capability.orca.terminal"
        | "capability.orca.start"
        | "capability.orca.lookup"
        | "capability.orca.adopt"
        | "capability.orca.unstarted"
        | "capability.orca.wait"
        | "capability.orca.stop"
        | "capability.orca.sessionState" => &["taskId", "attempt"],
        "capability.orca.abandon" => &["taskId", "attempt", "reason"],
        "capability.orca.settle" => &["taskId", "attempt", "settled"],
        "capability.orca.finish" => &[
            "taskId",
            "attempt",
            "code",
            "timedOut",
            "settled",
            "summary",
            "tail",
            "launchBroken",
            "keepAlive",
        ],
        "capability.net.http" => &[
            "url",
            "method",
            "headers",
            "body",
            "timeoutMs",
            "authorization",
        ],
        "capability.net.http.body.begin" => &["bytes"],
        "capability.net.http.body.readChunk" => &["handle", "offset", "length"],
        "capability.secrets.check" => &["ref"],
        "capability.identity.sign" | "capability.secrets.resolve" => return Ok(()),
        "capability.worktree.createOrReuse" => &["taskId", "attempt", "baseSha"],
        "capability.worktree.inspect" | "capability.worktree.resolveBase" => &["taskId", "attempt"],
        "capability.hosts.open" => &["alias"],
        "capability.hosts.run" => &[
            "session",
            "script",
            "args",
            "timeoutMs",
            "maxBytes",
            "stdin",
        ],
        "capability.hosts.fetch" => &["session", "timeoutMs", "maxBytes"],
        "capability.hosts.close" => &["session"],
        "capability.log" => &["level", "message"],
        "capability.config.get" => &[],
        _ => return Err(BrokerError::Invalid("unknown host method")),
    };
    if params.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(BrokerError::Invalid("unknown request field"));
    }
    if method.starts_with("capability.orca.") && method != "capability.orca.status" {
        validate_task_id(
            params
                .get("taskId")
                .and_then(Value::as_str)
                .ok_or(BrokerError::Invalid("taskId"))?,
        )?;
        let string = |key: &str, min: usize, max: usize| {
            params
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|s| (min..=max).contains(&crate::js_semantics::codepoint_len(s)))
        };
        if method == "capability.orca.abandon" && !string("reason", 1, 4096) {
            return Err(BrokerError::Invalid("Orca reason"));
        }
        if ["capability.orca.settle", "capability.orca.finish"].contains(&method)
            && !params.get("settled").is_some_and(Value::is_boolean)
        {
            return Err(BrokerError::Invalid("Orca settled"));
        }
        if method == "capability.orca.finish"
            && (params
                .get("code")
                .and_then(crate::js_semantics::safe_i64)
                .is_none()
                || !["timedOut", "keepAlive"]
                    .iter()
                    .all(|key| params.get(*key).is_some_and(Value::is_boolean))
                || !string("summary", 0, 65_536)
                || params.contains_key("tail") && !string("tail", 0, 65_536)
                || params.contains_key("launchBroken") && !string("launchBroken", 0, 4096))
        {
            return Err(BrokerError::Invalid("Orca finish"));
        }
    }
    Ok(())
}
fn validate_task_id(value: &str) -> Result<(), BrokerError> {
    let valid = value.strip_prefix("t-").is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 120
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    });
    if valid {
        Ok(())
    } else {
        Err(BrokerError::Invalid("taskId"))
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
