//! Service-owned adoption orchestration (port of `adoption-service.ts`).
//!
//! Drives the `desktop_adoptions` state machine through the shared
//! coordinator: `waiting → reserved → installing → committed` (or
//! `cancelled` / `recovery-failed`), re-verifying the adopted native
//! service, reserving idle bandwidth through the admission coordinator, and
//! running the helper adapter's `adopt` / `recover-adoption` commands over
//! the injected byte pipe. No coordinator callback ever crosses a native
//! await, matching the TypeScript service.
#![allow(
    clippy::result_large_err,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unwrap_used,
    clippy::await_holding_lock
)]
use crate::adapter::{
    AdapterError, AdapterOutcome, AdapterRequest, HandoffState, NativeSessionRef as PipeSessionRef,
    PipeFactory, run_adapter_command,
};
use crate::adoption_state::adoption_pending;
use crate::adoption_store::{
    begin_adoption, cancel_adoption, replay_adoption_request, transition_adoption,
};
use crate::runtime::NativeAuthority;
use crate::{list_adoptions, read_adoption};
use pacer_desktop_admission::reservation::{Reservation, release_reservation, reserve_idle};
use pacer_foundation::api::{Code, CoreError};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

fn unavailable() -> CoreError {
    CoreError::new(
        Code::NotAllowed,
        "Verified desktop service adoption is unavailable",
    )
    .hint("Connect the supported signed desktop to the inspected service.")
}

/// `UpdateRequest` shaped identically to the adoption store's request.
#[derive(Clone, Debug)]
pub struct UpdateRequest {
    pub installation_id: String,
    pub request_id: String,
    pub expect_revision: u64,
}

impl From<crate::policy::UpdateRequest> for UpdateRequest {
    fn from(r: crate::policy::UpdateRequest) -> Self {
        UpdateRequest {
            installation_id: r.installation_id,
            request_id: r.request_id,
            expect_revision: r.expect_revision,
        }
    }
}

/// The adoption runtime, mirroring `createAdoptionRuntime`.
pub struct AdoptionRuntime {
    home: PathBuf,
    native: Arc<dyn NativeAuthority>,
    factory: Option<Arc<dyn PipeFactory>>,
    boot_id: String,
    capabilities: HashSet<String>,
    reserve_deadline: std::time::Duration,
    started: AtomicBool,
    stopped: AtomicBool,
    active: Mutex<HashSet<String>>,
}

fn session_matches(s: &crate::runtime::NativeSession, value: &Value) -> bool {
    value
        .get("authority")
        .and_then(|a| a.get("target"))
        .and_then(|t| t.get("appPath"))
        .and_then(Value::as_str)
        == Some(s.installation.app_path.as_str())
        && value
            .get("authority")
            .and_then(|a| a.get("target"))
            .and_then(|t| t.get("pacerHome"))
            .and_then(Value::as_str)
            == Some(s.installation.pacer_home.as_str())
}

fn permitted(s: &crate::runtime::NativeSession, value: &Value) -> bool {
    let authority = value.get("authority");
    authority
        .and_then(|a| a.get("nativeSessionId"))
        .and_then(Value::as_str)
        == Some(s.session_id.as_str())
        && authority
            .and_then(|a| a.get("desktopClientId"))
            .and_then(Value::as_str)
            == Some(s.desktop_client_id.as_str())
        && authority
            .and_then(|a| a.get("bootId"))
            .and_then(Value::as_str)
            == Some(s.boot_id.as_str())
}

impl AdoptionRuntime {
    /// Create an adoption runtime over a verified native authority and the
    /// helper pipe factory.
    pub fn new(
        native: Arc<dyn NativeAuthority>,
        factory: Option<Arc<dyn PipeFactory>>,
        boot_id: String,
        capabilities: HashSet<String>,
        reserve_deadline: std::time::Duration,
        home: impl Into<PathBuf>,
    ) -> Self {
        AdoptionRuntime {
            home: home.into(),
            native,
            factory,
            boot_id,
            capabilities,
            reserve_deadline,
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            active: Mutex::new(HashSet::new()),
        }
    }

    /// `capable`.
    pub fn capable(&self) -> bool {
        self.capabilities.contains("adopt") && self.capabilities.contains("recover-adoption")
    }

    fn record(&self, id: &str) -> Option<Value> {
        read_adoption(&self.home, id).ok().flatten()
    }

    fn change(
        &self,
        value: &Value,
        phase: &str,
        patch: Option<&Value>,
    ) -> Result<Value, CoreError> {
        let id = value
            .get("installationId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
        transition_adoption(&self.home, id, revision, phase, patch)
    }

    /// `start`: cancel any waiting adoption left over from a previous run.
    pub fn start(&self) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        for value in list_adoptions(&self.home).unwrap_or_default() {
            if value.get("phase").and_then(Value::as_str) == Some("waiting") {
                let _ = self.cancel_waiting(&value);
            }
        }
    }

    fn cancel_waiting(&self, value: &Value) -> Result<(), CoreError> {
        let current = self.record(
            value
                .get("installationId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if let Some(current) = current
            && current.get("phase").and_then(Value::as_str) == Some("waiting")
            && current.get("transactionId") == value.get("transactionId")
        {
            self.change(&current, "cancelled", None)?;
            if let Some(tx) = current.get("transactionId").and_then(Value::as_str) {
                let _ = release_reservation(
                    &self.home,
                    &Reservation {
                        owner: Some(tx.to_string()),
                        reserved: true,
                        blockers: vec![],
                    },
                );
            }
        }
        Ok(())
    }

    /// `stop`.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    /// `tick`: advance pending adoptions.
    pub async fn tick(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let rows = list_adoptions(&self.home).unwrap_or_default();
        for value in rows {
            if !adoption_pending(&value) {
                continue;
            }
            let tx = value
                .get("transactionId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let Some(tx) = tx else { continue };
            if self.active.lock().unwrap().contains(&tx) {
                continue;
            }
            let s = self.session_for(&value);
            if value.get("phase").and_then(Value::as_str) == Some("waiting") {
                let Some(s) = s else {
                    let _ = self.cancel_waiting(&value);
                    continue;
                };
                if !permitted(&s, &value) {
                    let _ = self.cancel_waiting(&value);
                    continue;
                }
                if self.native.reverify(&s).await.is_err() {
                    let _ = self.cancel_waiting(&value);
                    continue;
                }
                let reservation = reserve_idle(&self.home, &tx, self.reserve_deadline).ok();
                let Some(reservation) = reservation else {
                    continue;
                };
                let current = self.record(
                    value
                        .get("installationId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                if let Some(current) = current {
                    if current.get("transactionId").and_then(Value::as_str) != Some(tx.as_str())
                        || current.get("phase").and_then(Value::as_str) != Some("waiting")
                    {
                        if reservation.reserved {
                            let _ = release_reservation(
                                &self.home,
                                &Reservation {
                                    owner: Some(tx.clone()),
                                    reserved: true,
                                    blockers: vec![],
                                },
                            );
                        }
                        continue;
                    }
                    if !reservation.reserved {
                        if current.get("blockers") != reservation_blockers(&reservation).as_ref() {
                            let _ = self.change(
                                &current,
                                "waiting",
                                Some(&json!({ "blockers": reservation.blockers })),
                            );
                        }
                        continue;
                    }
                    if self.stopped.load(Ordering::SeqCst)
                        || !s.is_alive()
                        || !permitted(&s, &current)
                    {
                        let _ = self.cancel_waiting(&current);
                        continue;
                    }
                    if let Ok(v) =
                        self.change(&current, "reserved", Some(&json!({ "blockers": [] })))
                    {
                        self.launch(v, s, false).await;
                    }
                }
            } else if let Some(s) = s
                && self.capable()
                && self.native.reverify(&s).await.is_ok()
            {
                self.launch(value, s, true).await;
            }
        }
    }

    fn session_for(&self, value: &Value) -> Option<crate::runtime::NativeSession> {
        self.native
            .sessions()
            .into_iter()
            .find(|s| session_matches(s, value))
    }

    async fn launch(&self, value: Value, s: crate::runtime::NativeSession, recovery: bool) {
        let tx = value
            .get("transactionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        {
            let mut active = self.active.lock().unwrap();
            if active.contains(&tx) {
                return;
            }
            active.insert(tx.clone());
        }
        let session = s.clone();
        let closed = session.closed.clone();
        let this_adoption = self.adoption_work(value.clone(), s, recovery);
        let _ = closed;
        self.active.lock().unwrap().remove(&tx);
        // Drive the adoption work inline (the helper pipe is async but the
        // runtime serializes adoptions itself).
        this_adoption.await;
    }

    async fn adoption_work(&self, value: Value, s: crate::runtime::NativeSession, recovery: bool) {
        let _ = s;
        let id = value
            .get("installationId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let tx = value
            .get("transactionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let command = if recovery {
            AdapterRequest::RecoverAdoption {
                installation_id: id.clone(),
                revision,
                transaction_id: tx.clone(),
            }
        } else {
            AdapterRequest::Adopt {
                installation_id: id.clone(),
                revision,
                transaction_id: tx.clone(),
                target: value
                    .get("authority")
                    .and_then(|a| a.get("target"))
                    .cloned()
                    .unwrap_or(Value::Null),
            }
        };
        let outcome = match self.run_adoption_command(&command).await {
            Ok(o) => o,
            Err(e) => {
                self.handle_adoption_error(&value, recovery, e);
                return;
            }
        };
        let outcome_name = outcome
            .frame
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if outcome_name == "recovery-failed" {
            let _ = self.change(&value, "recovery-failed", Some(&json!({
                "error": { "code": "recovery_failed", "message": "Desktop service adoption requires recovery" }
            })));
            return;
        }
        if outcome_name != "committed" && outcome_name != "restored" {
            self.handle_adoption_error(&value, recovery, failed_error());
            return;
        }
        let current = self.record(&id);
        let Some(current) = current else { return };
        if current.get("transactionId").and_then(Value::as_str) != Some(tx.as_str()) {
            return;
        }
        let proof = match self
            .native
            .verify_adoption_outcome(&current, &outcome_name)
            .await
        {
            Ok(p) => p,
            Err(_) => {
                self.handle_adoption_error(&value, recovery, failed_error());
                return;
            }
        };
        let _ = proof;
        let latest = self.record(&id);
        if let Some(latest) = latest {
            let terminal_phase = if outcome_name == "committed" {
                "committed"
            } else {
                "restored"
            };
            if let Ok(terminal) = self.change(
                &latest,
                terminal_phase,
                Some(&json!({
                    "resultingInstallationId": Value::Null,
                    "error": Value::Null,
                    "blockers": [],
                })),
            ) && let Some(t) = terminal.get("transactionId").and_then(Value::as_str)
            {
                let _ = release_reservation(
                    &self.home,
                    &Reservation {
                        owner: Some(t.to_string()),
                        reserved: true,
                        blockers: vec![],
                    },
                );
            }
        }
    }

    fn handle_adoption_error(&self, value: &Value, recovery: bool, e: CoreError) {
        let current = self.record(
            value
                .get("installationId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if let Some(current) = current {
            let same_tx = current.get("transactionId") == value.get("transactionId");
            if !same_tx || !adoption_pending(&current) {
                return;
            }
            if !recovery && e.code == Code::NotAllowed {
                let _ = self.change(
                    &current,
                    "cancelled",
                    Some(&json!({
                        "error": { "code": "pre_handoff", "message": e.to_string() }
                    })),
                );
                if let Some(t) = current.get("transactionId").and_then(Value::as_str) {
                    let _ = release_reservation(
                        &self.home,
                        &Reservation {
                            owner: Some(t.to_string()),
                            reserved: true,
                            blockers: vec![],
                        },
                    );
                }
            } else {
                let _ = self.change(&current, "recovery-failed", Some(&json!({
                    "error": { "code": "handoff_uncertain", "message": "Retain the adoption reservation for native recovery" }
                })));
            }
        }
    }

    async fn run_adoption_command(
        &self,
        request: &AdapterRequest,
    ) -> Result<AdapterOutcome, CoreError> {
        let Some(factory) = self.factory.clone() else {
            return Err(unavailable());
        };
        let id = match request {
            AdapterRequest::Check {
                installation_id, ..
            }
            | AdapterRequest::Download {
                installation_id, ..
            }
            | AdapterRequest::Install {
                installation_id, ..
            }
            | AdapterRequest::Recover {
                installation_id, ..
            }
            | AdapterRequest::Adopt {
                installation_id, ..
            }
            | AdapterRequest::RecoverAdoption {
                installation_id, ..
            } => installation_id.clone(),
        };
        let mut pipe = factory
            .open(&PipeSessionRef::new(id))
            .await
            .map_err(|_| unavailable())?;
        run_adapter_command(&mut *pipe, request, self.reserve_deadline)
            .await
            .map_err(adoption_adapter_error)
    }

    /// `adopt`.
    pub async fn adopt(&self, input: &UpdateRequest) -> Result<Value, CoreError> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let input_store = crate::adoption_store::UpdateRequest {
            installation_id: input.installation_id.clone(),
            request_id: input.request_id.clone(),
            expect_revision: input.expect_revision,
        };
        if let Some(replay) = replay_adoption_request(&self.home, &input_store, "adopt")? {
            return Ok(replay);
        }
        if !self.capable() {
            return Err(unavailable());
        }
        let s = self
            .native
            .sessions()
            .into_iter()
            .find(|s| {
                s.installation.id == input.installation_id
                    && s.is_alive()
                    && s.boot_id == self.boot_id
            })
            .ok_or_else(unavailable)?;
        self.native.reverify(&s).await?;
        if !s.is_alive() {
            return Err(unavailable());
        }
        let authority = self.native.inspect_adoption(&s).ok_or_else(unavailable)?;
        begin_adoption(&self.home, &input_store, &authority)
    }

    /// `cancel`.
    pub async fn cancel(&self, input: &UpdateRequest) -> Result<Value, CoreError> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let input_store = crate::adoption_store::UpdateRequest {
            installation_id: input.installation_id.clone(),
            request_id: input.request_id.clone(),
            expect_revision: input.expect_revision,
        };
        let next = cancel_adoption(&self.home, &input_store)?;
        if let Some(t) = next.get("transactionId").and_then(Value::as_str) {
            let _ = release_reservation(
                &self.home,
                &Reservation {
                    owner: Some(t.to_string()),
                    reserved: true,
                    blockers: vec![],
                },
            );
        }
        Ok(next)
    }
}

fn reservation_blockers(reservation: &Reservation) -> Option<Value> {
    Some(json!(reservation.blockers))
}

fn failed_error() -> CoreError {
    unavailable()
}

fn adoption_adapter_error(e: AdapterError) -> CoreError {
    if e.handoff == HandoffState::None {
        CoreError::new(
            Code::NotAllowed,
            format!("Desktop service adoption failed before handoff: {}", e),
        )
    } else {
        CoreError::new(
            Code::NotAllowed,
            format!("Desktop service adoption outcome is uncertain: {}", e),
        )
    }
}
