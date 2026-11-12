//! Native caller/provider host-session boundary. Provider handles never cross caller RPC.
use crate::{AuthorityError, BrokerError, CapabilityEffect, ProviderSnapshot};
use serde_json::{Value, json};
use std::{collections::HashMap, future::Future};
pub trait HostProvider {
    /// Settle an admitted open that never transferred a valid session to the host
    /// (dropped, rejected or invalid). Return `Ok` only when provider state proves no
    /// open effect is outstanding; an error, timeout or dropped future is not proof.
    /// The default refuses to certify cleanup. An `Err` becomes the sticky cleanup failure.
    fn retire_pending(&mut self) -> impl Future<Output = Result<(), BrokerError>> {
        async {
            Err(BrokerError::Effect(
                "pending host open cleanup unverified".into(),
            ))
        }
    }
    /// Host-only transfer of a staged provider artifact; never a path from RPC.
    fn fetch(
        &mut self,
        _params: Value,
    ) -> impl Future<Output = Result<crate::BundleTicket, BrokerError>> {
        async { Err(denied()) }
    }
    fn snapshot(&self, alias: &str) -> Option<ProviderSnapshot>;
    /// Resolve alias/SSH/control snapshots from the host's private issuance context.
    fn invoke(
        &mut self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
}
struct Session {
    snapshot: ProviderSnapshot,
    provider_session: String,
}
pub struct NativeHosts<P> {
    provider: P,
    issued: HashMap<String, ProviderSnapshot>,
    sessions: HashMap<String, Session>,
    fetched: Option<crate::BundleTicket>,
    opening: bool,
    cleanup_failure: Option<BrokerError>,
}
fn denied() -> BrokerError {
    AuthorityError::Denied("host provider or session changed".into()).into()
}
impl<P: HostProvider> NativeHosts<P> {
    pub fn new(provider: P, issued: impl IntoIterator<Item = ProviderSnapshot>) -> Self {
        Self {
            provider,
            issued: issued.into_iter().map(|s| (s.alias.clone(), s)).collect(),
            sessions: HashMap::new(),
            fetched: None,
            opening: false,
            cleanup_failure: None,
        }
    }
    /// The session stays owned until its provider close succeeds, so revoke can retry it.
    async fn retire_session(&mut self, handle: &str) -> Result<(), BrokerError> {
        if let Some(session) = self.sessions.get(handle) {
            let session = json!({"session":session.provider_session});
            if let Err(error) = self.provider.invoke("hostRunner.close", session).await {
                self.cleanup_failure.get_or_insert(error.clone());
                return Err(error);
            }
            self.sessions.remove(handle);
        }
        Ok(())
    }
    async fn settle_open(&mut self) {
        // A dropped settlement leaves `opening` set, so revoke settles again.
        let settled = self.provider.retire_pending().await;
        self.opening = false;
        if let Err(error) = settled {
            self.cleanup_failure.get_or_insert(error);
        }
    }
    pub fn claim_fetch(&mut self) -> Result<crate::BundleTicket, BrokerError> {
        self.fetched.take().ok_or_else(denied)
    }
    /// Retire every owned session and pending open. Returns the first cleanup failure.
    pub async fn revoke(&mut self) -> Result<(), BrokerError> {
        self.fetched = None;
        if self.opening {
            self.settle_open().await;
        }
        let handles = self.sessions.keys().cloned().collect::<Vec<_>>();
        for handle in handles {
            // A close failure is retained and does not stop the sweep.
            self.retire_session(&handle).await.ok();
        }
        self.cleanup_failure.clone().map_or(Ok(()), Err)
    }
}
impl<P: HostProvider> CapabilityEffect for NativeHosts<P> {
    fn native_host_sessions(&self) -> bool {
        true
    }
    fn provider_snapshot(&self, alias: &str) -> Option<ProviderSnapshot> {
        self.provider.snapshot(alias)
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        if let Some(error) = &self.cleanup_failure {
            return Err(error.clone());
        }
        if method == "capability.hosts.open" {
            if self.opening {
                return Err(denied());
            }
            let alias = params["alias"].as_str().ok_or_else(denied)?;
            let broker = params["session"].as_str().ok_or_else(denied)?;
            let snapshot = self
                .issued
                .get(alias)
                .filter(|s| self.provider.snapshot(alias).as_ref() == Some(s))
                .ok_or_else(denied)?
                .clone();
            if self.sessions.contains_key(broker) {
                return Err(denied());
            }
            self.opening = true;
            // No await may sit between receiving a valid handle and storing it.
            let opened = self
                .provider
                .invoke("hostRunner.open", json!({"alias":alias}))
                .await
                .and_then(|result| {
                    result["session"]
                        .as_str()
                        .filter(|s| {
                            s.len() >= 16
                                && s.len() <= 128
                                && s.bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                        })
                        .map(str::to_owned)
                        .ok_or_else(denied)
                });
            let provider_session = match opened {
                Ok(session) => session,
                Err(error) => {
                    self.settle_open().await;
                    return Err(error);
                }
            };
            self.sessions.insert(
                broker.into(),
                Session {
                    snapshot: snapshot.clone(),
                    provider_session,
                },
            );
            self.opening = false;
            if self.provider.snapshot(alias).as_ref() != Some(&snapshot) {
                self.retire_session(broker).await?;
                return Err(denied());
            }
            return Ok(json!({"ok":true}));
        }
        let handle = params["session"].as_str().ok_or_else(denied)?;
        if method == "capability.hosts.close" {
            if !self.sessions.contains_key(handle) {
                return Err(denied());
            }
            self.retire_session(handle).await?;
            return Ok(json!({"ok":true}));
        }
        if !["capability.hosts.run", "capability.hosts.fetch"].contains(&method) {
            return Err(BrokerError::Invalid("host method"));
        }
        let session = self.sessions.get(handle).ok_or_else(denied)?;
        let snapshot = session.snapshot.clone();
        let mut forwarded = params.clone();
        forwarded["session"] = json!(session.provider_session);
        if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot) {
            self.retire_session(handle).await?;
            return Err(denied());
        }
        if method == "capability.hosts.fetch" {
            if self.fetched.is_some() || forwarded["script"] != "BUNDLE_OUT" {
                return Err(denied());
            }
            let ticket = self.provider.fetch(forwarded).await?;
            if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot)
                || params
                    .get("maxBytes")
                    .and_then(crate::js_semantics::safe_u64)
                    .is_none_or(|max| ticket.bytes() > max)
            {
                drop(ticket);
                self.retire_session(handle).await?;
                return Err(denied());
            }
            self.fetched = Some(ticket);
            return Ok(json!({"ok":true}));
        }
        let result = self.provider.invoke("hostRunner.run", forwarded).await;
        if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot) {
            self.retire_session(handle).await?;
            return Err(denied());
        }
        let result = match result {
            Ok(value) => value,
            Err(error) => {
                self.retire_session(handle).await?;
                return Err(error);
            }
        };
        let max = params
            .get("maxBytes")
            .and_then(crate::js_semantics::safe_u64)
            .ok_or(BrokerError::Invalid("host output bound"))?;
        // TypeScript bounds the summed byte lengths of both streams.
        if result
            .get("code")
            .and_then(crate::js_semantics::safe_u64)
            .is_none_or(|n| n > 255)
            || !result["timedOut"].is_boolean()
            || result["stdout"]
                .as_str()
                .zip(result["stderr"].as_str())
                .is_none_or(|(out, err)| out.len().saturating_add(err.len()) as u64 > max)
        {
            self.retire_session(handle).await?;
            return Err(BrokerError::Invalid("host result"));
        }
        Ok(result)
    }
}
