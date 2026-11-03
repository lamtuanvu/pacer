//! Reconciliation is intentionally unavailable until the coordinator channel,
//! durable fencing, signed native measurements and independent recovery are proved.
//! Serialized claims alone must never construct any of the authority types below.
#![allow(dead_code)]

use super::OtaError;

#[derive(Clone, Debug)]
struct UntrustedRequest {
    version: u32,
    kind: String,
    transaction_id: String,
    coordinator: String,
    grant: String,
    boot: String,
    session: String,
    job: String,
    process: String,
    source: String,
    destination: String,
    reservation: String,
}

// No deserialization, public constructor, or conversion from wire claims. A future
// provider must create these only after independently verifying all native pins and
// consuming the grant against a durable, fenced reservation.
struct VerifiedRequest {
    _private: (),
}
struct VerifiedReservation {
    _private: (),
}
struct PreparedTransaction {
    _private: (),
}
enum RecordedEffect {
    StopInspectedJob,
    RegisterDestination,
    StartDestination,
}
struct EffectObservation {
    _private: (),
}

fn authenticate_coordinator(_request: &UntrustedRequest) -> Result<VerifiedRequest, OtaError> {
    Err(OtaError::Unavailable)
}

fn prepare_reconciliation(
    _request: VerifiedRequest,
    _reservation: VerifiedReservation,
) -> Result<PreparedTransaction, OtaError> {
    Err(OtaError::Unavailable)
}

fn apply_recorded_effect(
    _prepared: &mut PreparedTransaction,
    _effect: RecordedEffect,
) -> Result<EffectObservation, OtaError> {
    Err(OtaError::Unavailable)
}

#[cfg(test)]
mod tests;

mod journal;

mod peer_identity;
