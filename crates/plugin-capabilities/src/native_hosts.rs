//! Native caller/provider host-session boundary. Provider handles never cross caller RPC.
use crate::{AuthorityError, BrokerError, CapabilityEffect, ProviderSnapshot};
use serde_json::{Value, json};
use std::{collections::HashMap, future::Future};
pub trait HostProvider {
    /// Settle an admitted open that never transferred a valid session to the host.
    /// This covers three cases: the open future was dropped, `invoke` returned an
    /// error, or `invoke` returned a result the host rejected. Return `Ok` only when
    /// the provider's own state proves no open effect is still outstanding: the open
    /// was never dispatched, it failed definitely without creating a handle, or its
    /// exact handle was closed. Never return `Ok` just because `invoke` returned an
    /// error, a timeout elapsed, a future was dropped or a process disappeared. This
    /// may be called again after an earlier settlement future was dropped. The
    /// default refuses to certify cleanup. An `Err` is retained as the effect's
    /// sticky cleanup failure and is not retried.
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
                self.cleanup_failure.get_or_insert(error.clone());
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
    /// Retire everything this effect owns. Callers must invoke this (directly, or through
    /// `CapabilityBroker::revoke_owned`) when the call ends and surface its error; an ordinary
    /// failed operation does not retire. Returns the first retained cleanup cause, if any.
    pub async fn revoke(&mut self) -> Result<(), BrokerError> {
        if let Some(ticket) = self.fetched.take()
            && let Err(error) = ticket.dispose()
        {
            self.cleanup_failure.get_or_insert(error);
        }
        if self.opening {
            // Dropped here: `opening` stays set and a later revoke re-enters settlement.
            let settled = self.provider.retire_pending().await;
            self.opening = false;
            if let Err(error) = settled {
                self.cleanup_failure.get_or_insert(error);
            }
        }
        let handles = self.sessions.keys().cloned().collect::<Vec<_>>();
        for handle in handles {
            // A returned close error does not stop the sweep. Cancellation retains the
            // exact handle for a later revoke.
            self.retire_session(&handle).await.ok();
        }
        self.cleanup_failure.clone().map_or(Ok(()), Err)
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
                    // No valid handle reached host ownership; only the provider can settle it.
                    // Dropped here: `opening` stays set for revoke's re-entry.
                    let settled = self.provider.retire_pending().await;
                    self.opening = false;
                    if let Err(cleanup) = settled {
                        self.cleanup_failure.get_or_insert(cleanup);
                    }
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
