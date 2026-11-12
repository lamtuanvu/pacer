//! Native caller/provider host-session boundary. Provider handles never cross caller RPC.
use crate::{AuthorityError, BrokerError, CapabilityEffect, ProviderSnapshot};
use serde_json::{Value, json};
use std::{collections::HashMap, future::Future};
pub trait HostProvider {
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
        }
    }
    /// Retired regardless of the close result, as TypeScript `host-lease.ts` does. A dropped
    /// close future keeps the session owned, so revoke can still close it.
    async fn retire_session(&mut self, handle: &str) -> Result<(), BrokerError> {
        let Some(session) = self.sessions.get(handle) else {
            return Ok(());
        };
        let session = json!({"session":session.provider_session});
        let closed = self.provider.invoke("hostRunner.close", session).await;
        self.sessions.remove(handle);
        closed.map(drop)
    }
    pub fn claim_fetch(&mut self) -> Result<crate::BundleTicket, BrokerError> {
        self.fetched.take().ok_or_else(denied)
    }
    /// Retire every owned session. Returns the first close failure of this sweep.
    pub async fn revoke(&mut self) -> Result<(), BrokerError> {
        self.fetched = None;
        let mut failure = None;
        let handles = self.sessions.keys().cloned().collect::<Vec<_>>();
        for handle in handles {
            if let Err(error) = self.retire_session(&handle).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
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
        if method == "capability.hosts.open" {
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
            // A failed or invalid open owns no provider session, so nothing is retired.
            // No await may sit between receiving a valid handle and storing it.
            let result = self
                .provider
                .invoke("hostRunner.open", json!({"alias":alias}))
                .await?;
            let provider_session = result["session"]
                .as_str()
                .filter(|s| {
                    s.len() >= 16
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                })
                .ok_or_else(denied)?
                .to_owned();
            self.sessions.insert(
                broker.into(),
                Session {
                    snapshot: snapshot.clone(),
                    provider_session,
                },
            );
            if self.provider.snapshot(alias).as_ref() != Some(&snapshot) {
                self.retire_session(broker).await.ok();
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
        // Every failure below retires the session; the caller sees the operation's error.
        if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot) {
            self.retire_session(handle).await.ok();
            return Err(denied());
        }
        if method == "capability.hosts.fetch" {
            if self.fetched.is_some() || forwarded["script"] != "BUNDLE_OUT" {
                return Err(denied());
            }
            let ticket = match self.provider.fetch(forwarded).await {
                Ok(ticket) => ticket,
                Err(error) => {
                    self.retire_session(handle).await.ok();
                    return Err(error);
                }
            };
            if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot)
                || params
                    .get("maxBytes")
                    .and_then(crate::js_semantics::safe_u64)
                    .is_none_or(|max| ticket.bytes() > max)
            {
                drop(ticket);
                self.retire_session(handle).await.ok();
                return Err(denied());
            }
            self.fetched = Some(ticket);
            return Ok(json!({"ok":true}));
        }
        let result = self.provider.invoke("hostRunner.run", forwarded).await;
        if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot) {
            self.retire_session(handle).await.ok();
            return Err(denied());
        }
        let result = match result {
            Ok(value) => value,
            Err(error) => {
                self.retire_session(handle).await.ok();
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
            self.retire_session(handle).await.ok();
            return Err(BrokerError::Invalid("host result"));
        }
        Ok(result)
    }
}
