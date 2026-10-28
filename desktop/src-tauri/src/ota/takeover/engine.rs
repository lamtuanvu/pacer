use super::journal::{
    StepOutcome, TakeoverAction as Action, TakeoverManifest, TakeoverState as State,
    TakeoverStore,
};
use crate::ota::{AwakeStamp, OtaError, VERIFY_TIMEOUT_MS};

pub trait TakeoverPlatform {
    fn awake_now(&self) -> Result<AwakeStamp, OtaError>;
    fn redetect(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn arm_recovery(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn stop_original(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn switch_registration(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn launch_managed(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn verify_managed(&self, m: &TakeoverManifest, deadline: AwakeStamp) -> Result<(), OtaError>;
    fn restore_registration(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn launch_original(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
    fn verify_original(&self, m: &TakeoverManifest, deadline: AwakeStamp) -> Result<(), OtaError>;
    fn retire_recovery(&self, m: &TakeoverManifest) -> Result<(), OtaError>;
}

fn deadline(p: &dyn TakeoverPlatform) -> Result<AwakeStamp, OtaError> {
    let mut now = p.awake_now()?;
    now.millis = now
        .millis
        .checked_add(VERIFY_TIMEOUT_MS)
        .ok_or(OtaError::Invalid)?;
    Ok(now)
}

/// A failed step together with its public reason code (`<step>:<error>`).
struct Failure {
    reason: String,
    error: OtaError,
}

fn error_code(error: OtaError) -> String {
    serde_json::to_value(error)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

fn action_code(action: &Action) -> &'static str {
    match action {
        Action::ArmRecovery => "arm-recovery",
        Action::StopOriginal => "stop-original",
        Action::SwitchRegistration => "switch-registration",
        Action::LaunchManaged => "launch-managed",
        Action::Verify => "verify",
        Action::RetireRecovery => "retire-recovery",
        Action::RestoreRegistration => "restore-registration",
        Action::LaunchOriginal => "launch-original",
    }
}

fn failure(stage: &str, error: OtaError) -> Failure {
    Failure {
        reason: format!("{stage}:{}", error_code(error)),
        error,
    }
}

fn journal_failure(error: OtaError) -> Failure {
    failure("journal", error)
}

fn effect(
    store: &TakeoverStore,
    action: Action,
    perform: impl FnOnce() -> Result<(), OtaError>,
) -> Result<(), Failure> {
    store.intend(action.clone()).map_err(journal_failure)?;
    let result = perform();
    // The call returned, so its outcome is observed. A crash inside the call
    // leaves an uncompleted intent and is handled conservatively by recover.
    let outcome = if result.is_ok() {
        StepOutcome::Ok
    } else {
        StepOutcome::Failed
    };
    store.complete(&action, outcome).map_err(journal_failure)?;
    result.map_err(|error| failure(action_code(&action), error))
}

fn restore(
    store: &TakeoverStore,
    p: &dyn TakeoverPlatform,
    progress: &mut dyn FnMut(State),
    cause: Option<&str>,
) -> Result<State, OtaError> {
    let journal = store.journal()?;
    if journal.state != State::Restoring {
        store.transition_with(State::Restoring, cause)?;
        progress(State::Restoring);
    }
    let m = store.manifest();
    let result: Result<(), Failure> = (|| {
        effect(store, Action::RestoreRegistration, || {
            p.restore_registration(m)
        })?;
        effect(store, Action::LaunchOriginal, || p.launch_original(m))?;
        effect(store, Action::Verify, || {
            p.verify_original(m, deadline(p)?)
        })?;
        Ok(())
    })();
    let state = match result {
        Ok(()) => {
            store.transition(State::Restored)?;
            State::Restored
        }
        Err(failed) => {
            store.transition_with(State::RecoveryFailed, Some(&failed.reason))?;
            State::RecoveryFailed
        }
    };
    progress(state);
    if state == State::Restored {
        let _ = p.retire_recovery(m);
    }
    Ok(state)
}

pub fn execute(store: &TakeoverStore, p: &dyn TakeoverPlatform) -> Result<State, OtaError> {
    execute_with_progress(store, p, &mut |_| {})
}

pub fn execute_with_progress(
    store: &TakeoverStore,
    p: &dyn TakeoverPlatform,
    progress: &mut dyn FnMut(State),
) -> Result<State, OtaError> {
    let m = store.manifest();
    p.redetect(m)?;
    if let Err(failed) = effect(store, Action::ArmRecovery, || p.arm_recovery(m)) {
        // A failed arm may have partially loaded the recovery job.
        return restore(store, p, progress, Some(&failed.reason)).or(Err(failed.error));
    }
    let outcome: Result<State, Failure> = (|| {
        store.transition(State::Stopping).map_err(journal_failure)?;
        progress(State::Stopping);
        effect(store, Action::StopOriginal, || p.stop_original(m))?;
        store.transition(State::Switched).map_err(journal_failure)?;
        progress(State::Switched);
        effect(store, Action::SwitchRegistration, || {
            p.switch_registration(m)
        })?;
        effect(store, Action::LaunchManaged, || p.launch_managed(m))?;
        store.transition(State::Verifying).map_err(journal_failure)?;
        progress(State::Verifying);
        effect(store, Action::Verify, || p.verify_managed(m, deadline(p)?))?;
        store.transition(State::Committed).map_err(journal_failure)?;
        progress(State::Committed);
        let _ = p.retire_recovery(m);
        Ok(State::Committed)
    })();
    outcome.or_else(|failed| restore(store, p, progress, Some(&failed.reason)))
}

pub fn recover(store: &TakeoverStore, p: &dyn TakeoverPlatform) -> Result<State, OtaError> {
    let journal = store.journal()?;
    match journal.state {
        State::Committed => {
            p.retire_recovery(store.manifest())?;
            Ok(State::Committed)
        }
        State::Restored => {
            p.retire_recovery(store.manifest())?;
            Ok(journal.state)
        }
        State::RecoveryFailed => Ok(State::RecoveryFailed),
        State::Prepared if journal.steps.is_empty() => {
            store.transition(State::Restored)?;
            Ok(State::Restored)
        }
        _ => {
            let interrupted = journal
                .steps
                .iter()
                .find(|s| s.completed.is_none() && s.uncertain.is_none())
                .map(|s| format!("interrupted:{}", action_code(&s.action)));
            if interrupted.is_some() {
                store.mark_uncertain()?;
            }
            let cause = interrupted.unwrap_or_else(|| "interrupted".into());
            restore(store, p, &mut |_| {}, Some(&cause))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        calls: Mutex<Vec<&'static str>>,
        managed_registration: Mutex<bool>,
        fail: Option<&'static str>,
    }
    impl Fake {
        fn new(fail: Option<&'static str>) -> Self {
            Self {
                calls: Mutex::new(vec![]),
                managed_registration: Mutex::new(false),
                fail,
            }
        }
        fn call(&self, name: &'static str) -> Result<(), OtaError> {
            self.calls.lock().unwrap().push(name);
            if self.fail == Some(name) {
                Err(OtaError::Identity)
            } else {
                if name == "switch" {
                    *self.managed_registration.lock().unwrap() = true;
                } else if name == "restore" {
                    *self.managed_registration.lock().unwrap() = false;
                }
                Ok(())
            }
        }
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
        fn managed_registration(&self) -> bool {
            *self.managed_registration.lock().unwrap()
        }
    }
    impl TakeoverPlatform for Fake {
        fn awake_now(&self) -> Result<AwakeStamp, OtaError> {
            crate::ota::native::awake_now().map_err(|_| OtaError::Io)
        }
        fn redetect(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("redetect")
        }
        fn arm_recovery(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("arm")
        }
        fn stop_original(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("stop")
        }
        fn switch_registration(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("switch")
        }
        fn launch_managed(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("launch-managed")
        }
        fn verify_managed(&self, _: &TakeoverManifest, _: AwakeStamp) -> Result<(), OtaError> {
            self.call("verify-managed")
        }
        fn restore_registration(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("restore")
        }
        fn launch_original(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("launch-original")
        }
        fn verify_original(&self, _: &TakeoverManifest, _: AwakeStamp) -> Result<(), OtaError> {
            self.call("verify-original")
        }
        fn retire_recovery(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
            self.call("retire")
        }
    }
    fn fixture() -> (tempfile::TempDir, TakeoverStore) {
        let temp = tempfile::tempdir().unwrap();
        let manifest: TakeoverManifest = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/desktop-update/takeover-manifest.json"
        )))
        .unwrap();
        let store = TakeoverStore::create(temp.path(), &manifest).unwrap();
        (temp, store)
    }
    #[test]
    fn transaction_happy_path_and_redetection_refusal() {
        let (_temp, store) = fixture();
        let fake = Fake::new(None);
        let mut states = vec![];
        assert_eq!(
            execute_with_progress(&store, &fake, &mut |state| states.push(state)),
            Ok(State::Committed)
        );
        assert_eq!(
            states,
            [
                State::Stopping,
                State::Switched,
                State::Verifying,
                State::Committed
            ]
        );
        assert_eq!(
            fake.calls(),
            [
                "redetect",
                "arm",
                "stop",
                "switch",
                "launch-managed",
                "verify-managed",
                "retire"
            ]
        );
        let (_temp, store) = fixture();
        let fake = Fake::new(Some("redetect"));
        assert_eq!(execute(&store, &fake), Err(OtaError::Identity));
        assert!(store.journal().unwrap().steps.is_empty());
        assert_eq!(store.journal().unwrap().error, None);
        assert_eq!(fake.calls(), ["redetect"]);
    }
    #[test]
    fn every_forward_failure_restores_original() {
        for (fail, action, reason) in [
            ("stop", Action::StopOriginal, "stop-original:identity"),
            ("switch", Action::SwitchRegistration, "switch-registration:identity"),
            ("launch-managed", Action::LaunchManaged, "launch-managed:identity"),
            ("verify-managed", Action::Verify, "verify:identity"),
        ] {
            let (_temp, store) = fixture();
            let fake = Fake::new(Some(fail));
            assert_eq!(execute(&store, &fake), Ok(State::Restored), "{fail}");
            let journal = store.journal().unwrap();
            assert_eq!(journal.error.as_deref(), Some(reason), "{fail}");
            let failed: Vec<_> = journal
                .steps
                .iter()
                .filter(|s| s.outcome == Some(StepOutcome::Failed))
                .collect();
            assert_eq!(failed.len(), 1, "{fail}");
            assert_eq!(failed[0].action, action, "{fail}");
            assert!(journal
                .steps
                .iter()
                .rev()
                .take(3)
                .all(|s| s.outcome == Some(StepOutcome::Ok)));
            assert!(fake.calls().ends_with(&[
                "restore",
                "launch-original",
                "verify-original",
                "retire"
            ]));
            assert!(!fake.managed_registration(), "{fail}");
        }
    }
    #[test]
    fn restoration_failure_keeps_recovery_state() {
        let (_temp, store) = fixture();
        store.intend(Action::ArmRecovery).unwrap();
        store.complete(&Action::ArmRecovery, StepOutcome::Ok).unwrap();
        let fake = Fake::new(Some("restore"));
        assert_eq!(recover(&store, &fake), Ok(State::RecoveryFailed));
        let journal = store.journal().unwrap();
        assert_eq!(journal.state, State::RecoveryFailed);
        assert_eq!(journal.error.as_deref(), Some("restore-registration:identity"));
        assert_eq!(
            journal.steps.last().unwrap().outcome,
            Some(StepOutcome::Failed)
        );
        assert_eq!(fake.calls(), ["restore"]);
    }
    #[test]
    fn interrupted_recovery_records_the_interrupted_step() {
        let (_temp, store) = fixture();
        store.intend(Action::ArmRecovery).unwrap();
        store.complete(&Action::ArmRecovery, StepOutcome::Ok).unwrap();
        store.transition(State::Stopping).unwrap();
        store.intend(Action::StopOriginal).unwrap();
        assert_eq!(recover(&store, &Fake::new(None)), Ok(State::Restored));
        let journal = store.journal().unwrap();
        assert_eq!(journal.error.as_deref(), Some("interrupted:stop-original"));
        assert_eq!(journal.steps[1].outcome, None);
        assert!(journal.steps[1].uncertain.is_some());
    }
    #[test]
    fn committed_recovery_only_retires() {
        let (_temp, store) = fixture();
        execute(&store, &Fake::new(None)).unwrap();
        let fake = Fake::new(None);
        assert_eq!(recover(&store, &fake), Ok(State::Committed));
        assert_eq!(fake.calls(), ["retire"]);
    }
    #[test]
    fn same_boot_uncompleted_actions_are_never_replayed() {
        for (state, action) in [
            (State::Prepared, Action::ArmRecovery),
            (State::Stopping, Action::StopOriginal),
            (State::Switched, Action::SwitchRegistration),
            (State::Switched, Action::LaunchManaged),
            (State::Verifying, Action::Verify),
            (State::Restoring, Action::RestoreRegistration),
            (State::Restoring, Action::LaunchOriginal),
            (State::Restoring, Action::Verify),
        ] {
            let (_temp, store) = fixture();
            if state != State::Prepared {
                store.intend(Action::ArmRecovery).unwrap();
                store.complete(&Action::ArmRecovery, StepOutcome::Ok).unwrap();
                store.transition(State::Stopping).unwrap();
                if matches!(state, State::Switched | State::Verifying) {
                    store.transition(State::Switched).unwrap();
                }
                if state == State::Verifying {
                    store.transition(State::Verifying).unwrap();
                }
                if state == State::Restoring {
                    store.transition(State::Restoring).unwrap();
                }
            }
            store.intend(action).unwrap();
            let fake = Fake::new(None);
            assert_eq!(recover(&store, &fake), Ok(State::Restored));
            assert_eq!(
                fake.calls(),
                ["restore", "launch-original", "verify-original", "retire"]
            );
            assert!(store
                .journal()
                .unwrap()
                .steps
                .last()
                .is_some_and(|step| step.completed.is_some()));
        }
    }
    #[test]
    fn prior_boot_intent_is_marked_uncertain_and_never_replayed() {
        for (state, action, forbidden) in [
            (State::Prepared, Action::ArmRecovery, "arm"),
            (State::Stopping, Action::StopOriginal, "stop"),
            (State::Switched, Action::SwitchRegistration, "switch"),
            (State::Switched, Action::LaunchManaged, "launch-managed"),
            (State::Verifying, Action::Verify, "verify-managed"),
            (State::Restoring, Action::RestoreRegistration, "unused"),
            (State::Restoring, Action::LaunchOriginal, "unused"),
            (State::Restoring, Action::Verify, "unused"),
        ] {
            let (temp, store) = fixture();
            if state != State::Prepared {
                store.intend(Action::ArmRecovery).unwrap();
                store.complete(&Action::ArmRecovery, StepOutcome::Ok).unwrap();
                store.transition(State::Stopping).unwrap();
                if matches!(state, State::Switched | State::Verifying) {
                    store.transition(State::Switched).unwrap();
                }
                if state == State::Verifying {
                    store.transition(State::Verifying).unwrap();
                }
                if state == State::Restoring {
                    store.transition(State::Restoring).unwrap();
                }
            }
            store.intend(action).unwrap();
            let path = temp
                .path()
                .join("desktop-updates/native/takeover")
                .join(store.manifest().transaction_id.clone())
                .join("takeover-journal.json");
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let last = value["steps"].as_array().unwrap().len() - 1;
            value["steps"][last]["intentBootId"] = serde_json::json!("prior-boot");
            std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            let fake = Fake::new(None);
            assert_eq!(recover(&store, &fake), Ok(State::Restored));
            if forbidden != "unused" {
                assert!(!fake.calls().contains(&forbidden));
            }
            assert!(store.journal().unwrap().steps[last].uncertain.is_some());
        }
    }
    #[test]
    fn outstanding_intent_with_failed_restore_ends_recovery_failed() {
        for action in [Action::StopOriginal, Action::SwitchRegistration] {
            let (_temp, store) = fixture();
            store.intend(Action::ArmRecovery).unwrap();
            store.complete(&Action::ArmRecovery, StepOutcome::Ok).unwrap();
            store.transition(State::Stopping).unwrap();
            if action == Action::SwitchRegistration {
                store.transition(State::Switched).unwrap();
            }
            store.intend(action).unwrap();
            let fake = Fake::new(Some("restore"));
            assert_eq!(recover(&store, &fake), Ok(State::RecoveryFailed));
            assert_eq!(store.journal().unwrap().state, State::RecoveryFailed);
            assert_eq!(fake.calls(), ["restore"]);
        }
    }
    #[test]
    fn restore_crash_midway_restarts_restoration() {
        let (_temp, store) = fixture();
        store.intend(Action::ArmRecovery).unwrap();
        store.complete(&Action::ArmRecovery, StepOutcome::Ok).unwrap();
        store.transition(State::Restoring).unwrap();
        store.intend(Action::RestoreRegistration).unwrap();
        store.complete(&Action::RestoreRegistration, StepOutcome::Ok).unwrap();
        store.intend(Action::LaunchOriginal).unwrap();
        let fake = Fake::new(None);
        assert_eq!(recover(&store, &fake), Ok(State::Restored));
        assert_eq!(
            fake.calls(),
            ["restore", "launch-original", "verify-original", "retire"]
        );
        assert_eq!(store.journal().unwrap().state, State::Restored);
    }
}
