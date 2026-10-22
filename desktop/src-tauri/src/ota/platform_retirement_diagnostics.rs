//! Fixed fixture refusal metadata; never process/path/client data or authority.
use super::{CodeRole, OtaError};
#[derive(Clone, Copy)]
pub(super) enum Stage {
    StopExact,
    Observe,
    ManagerAbsent,
    Ledger,
    LedgerPolicy,
    GlobalInventory,
    PriorIdentity,
    Transition,
    LedgerReplace,
}
#[derive(Clone, Copy)]
enum Cause {
    Error(OtaError),
    LiveExecutable,
    PriorStillLive,
}
fn line(role: CodeRole, stage: Stage, cause: Cause) -> String {
    let job = match role {
        CodeRole::Cli => "service",
        CodeRole::Helper => "recovery",
        _ => "other",
    };
    let stage = match stage {
        Stage::StopExact => "stop-exact",
        Stage::Observe => "observe",
        Stage::ManagerAbsent => "manager-absent",
        Stage::Ledger => "ledger",
        Stage::LedgerPolicy => "ledger-policy",
        Stage::GlobalInventory => "global-inventory",
        Stage::PriorIdentity => "prior-identity",
        Stage::Transition => "transition",
        Stage::LedgerReplace => "ledger-replace",
    };
    let cause = match cause {
        Cause::LiveExecutable => "live-executable-observed",
        Cause::PriorStillLive => "prior-incarnation-observed",
        Cause::Error(error) => match error {
            OtaError::Unavailable => "unavailable",
            OtaError::Invalid => "invalid",
            OtaError::Io => "io",
            OtaError::Busy => "busy",
            OtaError::Identity => "identity",
            OtaError::Timeout => "timeout",
            OtaError::Interrupted => "interrupted",
            OtaError::RecoveryFailed => "recovery-failed",
        },
    };
    format!("pacer-fixture-retire job={job} stage={stage} cause={cause}\n")
}
fn emit(role: CodeRole, stage: Stage, cause: Cause) {
    use std::io::Write;
    // At most one short line per unwinding wrapper; stderr is already captured
    // by the bounded harness. Best effort preserves the original refusal.
    let _ = std::io::stderr()
        .lock()
        .write_all(line(role, stage, cause).as_bytes());
}
pub(super) fn step<T>(
    role: CodeRole,
    stage: Stage,
    result: Result<T, OtaError>,
) -> Result<T, OtaError> {
    if let Err(error) = &result {
        emit(role, stage, Cause::Error(*error));
    }
    result
}
pub(super) fn transition<T>(
    role: CodeRole,
    live: bool,
    prior_live: bool,
    result: Result<T, OtaError>,
) -> Result<T, OtaError> {
    if let Err(error) = &result {
        let cause = if live {
            Cause::LiveExecutable
        } else if prior_live {
            Cause::PriorStillLive
        } else {
            Cause::Error(*error)
        };
        emit(role, Stage::Transition, cause);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_vocabulary_has_no_external_input() {
        assert_eq!(
            line(
                CodeRole::Helper,
                Stage::GlobalInventory,
                Cause::Error(OtaError::Identity)
            ),
            "pacer-fixture-retire job=recovery stage=global-inventory cause=identity\n"
        );
        for stage in [
            Stage::StopExact,
            Stage::Observe,
            Stage::ManagerAbsent,
            Stage::Ledger,
            Stage::LedgerPolicy,
            Stage::GlobalInventory,
            Stage::PriorIdentity,
            Stage::Transition,
            Stage::LedgerReplace,
        ] {
            for cause in [
                Cause::LiveExecutable,
                Cause::PriorStillLive,
                Cause::Error(OtaError::Unavailable),
                Cause::Error(OtaError::Invalid),
                Cause::Error(OtaError::Io),
                Cause::Error(OtaError::Busy),
                Cause::Error(OtaError::Identity),
                Cause::Error(OtaError::Timeout),
                Cause::Error(OtaError::Interrupted),
                Cause::Error(OtaError::RecoveryFailed),
            ] {
                let value = line(CodeRole::Cli, stage, cause);
                assert!(
                    value.len() < 128
                        && value.lines().count() == 1
                        && !value.contains('/')
                        && !value.contains('{')
                );
            }
        }
    }
    #[test]
    fn original_results_survive_diagnostics() {
        let value = vec![1, 2, 3];
        assert_eq!(
            step(CodeRole::Cli, Stage::Observe, Ok(value.clone())),
            Ok(value)
        );
        assert_eq!(
            step::<()>(CodeRole::Cli, Stage::StopExact, Err(OtaError::Identity)),
            Err(OtaError::Identity)
        );
        assert_eq!(
            transition::<()>(CodeRole::Helper, true, false, Err(OtaError::Invalid)),
            Err(OtaError::Invalid)
        );
    }
}
