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
                let host = url.host_str().ok_or(BrokerError::Invalid("host"))?;
                self.authority.http_host(host)?;
                if !scopes.iter().any(|s| s == host) {
                    return Err(AuthorityError::Denied("undeclared HTTP host".into()).into());
                }
                if let Some(secret) = p
                    .get("authorization")
                    .and_then(|v| v.get("secretRef"))
                    .and_then(Value::as_str)
                {
                    self.authority.secret_alias(secret)?;
                }
                if let Some(body) = p.get("body") {
                    if let Some(handle) = body.get("handle").and_then(Value::as_str) {
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
        let deadline = self.method_deadline(method);
        let mut result = match timeout_at(deadline.into(), effect.call(method, forwarded)).await {
            Ok(value) => value?,
            Err(_) => {
                self.revoke();
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
