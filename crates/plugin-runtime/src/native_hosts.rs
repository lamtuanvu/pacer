//! Native caller/provider host-session boundary. Provider handles never cross caller RPC.
use crate::{AuthorityError, BrokerError, CapabilityEffect, ProviderSnapshot};
use serde_json::{Value, json};
use std::{collections::HashMap, future::Future};
pub trait HostProvider {
    /// Settle an open whose future was cancelled before a session was returned.
    /// A provider must retain any external in-flight ownership until this settles.
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
    async fn retire_session(&mut self, handle: &str) -> Result<(), BrokerError> {
        if let Some(session) = self.sessions.get(handle) {
            let result = self
                .provider
                .invoke(
                    "hostRunner.close",
                    json!({"session":session.provider_session}),
                )
                .await;
            if let Err(error) = result {
                self.cleanup_failure = Some(error.clone());
                return Err(error);
            }
            self.sessions.remove(handle);
        }
        Ok(())
    }
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
    pub fn claim_fetch(&mut self) -> Result<crate::BundleTicket, BrokerError> {
        self.fetched.take().ok_or_else(denied)
    }
    pub async fn revoke(&mut self) -> Result<(), BrokerError> {
        if let Some(error) = &self.cleanup_failure {
            return Err(error.clone());
        }
        let pending = if self.opening {
            self.provider.retire_pending().await.err()
        } else {
            None
        };
        self.opening = false;
        let mut failure = self
            .fetched
            .take()
            .and_then(|ticket| ticket.dispose().err());
        failure = failure.or(pending);
        let handles = self.sessions.keys().cloned().collect::<Vec<_>>();
        for handle in handles {
            if let Err(error) = self.retire_session(&handle).await {
                failure = Some(error);
            }
        }
        if let Some(error) = failure {
            self.cleanup_failure = Some(error.clone());
            return Err(error);
        }
        Ok(())
    }
}
impl<P: HostProvider> CapabilityEffect for NativeHosts<P> {
    async fn retire(&mut self) -> Result<(), BrokerError> {
        self.revoke().await
    }
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
            self.opening = false;
            self.sessions.insert(
                broker.into(),
                Session {
                    snapshot: snapshot.clone(),
                    provider_session,
                },
            );
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
        if self.provider.snapshot(&snapshot.alias).as_ref() != Some(&snapshot) {
            self.retire_session(handle).await?;
            return Err(denied());
        }
        let mut forwarded = params.clone();
        forwarded["session"] = json!(session.provider_session);
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
                let cleanup = ticket.dispose();
                self.retire_session(handle).await?;
                cleanup?;
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
