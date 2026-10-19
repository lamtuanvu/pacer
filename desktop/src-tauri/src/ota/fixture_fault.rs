//! One-shot faults for an explicitly compiled, live harness lease only.

use super::{
    fixture_policy::FixturePolicy,
    native::{self, ProcessIdentity},
    platform_fs::PrivateDir,
    trust::{CodeRole, ReleaseTrust},
    OtaError,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Point {
    Authorized,
    Installed,
    Restore,
    CandidateStartup,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Scenario {
    Upgrade,
    StartupFailure,
    HelperCrash,
    InterruptedInstall,
    RestoreFailure,
}
impl Scenario {
    fn points(self) -> &'static [Point] {
        match self {
            Self::Upgrade => &[],
            Self::StartupFailure => &[Point::CandidateStartup],
            Self::HelperCrash => &[Point::Authorized],
            Self::InterruptedInstall => &[Point::Installed],
            Self::RestoreFailure => &[Point::CandidateStartup, Point::Restore],
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum State {
    Armed,
    Running,
    Complete,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Consumption {
    process: ProcessIdentity,
    transaction_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fault {
    point: Point,
    #[serde(deserialize_with = "super::required_nullable")]
    consumed: Option<Consumption>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exercise {
    schema: u32,
    scenario: Scenario,
    state: State,
    driver: ProcessIdentity,
    installation_id: String,
    #[serde(deserialize_with = "super::required_nullable")]
    transaction_id: Option<String>,
    faults: Vec<Fault>,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn process_valid(value: &ProcessIdentity) -> bool {
    value.pid > 0
        && !value.boot_id.is_empty()
        && value.boot_id.len() <= 128
        && !value.birth.is_empty()
        && value.birth.len() <= 128
}

/// The caller supplies an already validated native transaction or maintenance
/// ticket. Only this helper/desktop's compiled lease can consume the fixed fault.
pub fn consume(
    point: Point,
    installation_id: &str,
    transaction_id: &str,
) -> Result<bool, OtaError> {
    let trust = ReleaseTrust::configured().ok_or(OtaError::Unavailable)?;
    let policy = trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    let own = native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(
        &own.identity,
        if point == Point::CandidateStartup {
            CodeRole::Desktop
        } else {
            CodeRole::Helper
        },
    )?;
    consume_bound(
        policy,
        point,
        installation_id,
        transaction_id,
        &own.identity,
        env!("CARGO_PKG_VERSION"),
        &|driver| {
            Ok(native::process_details(driver.pid)
                .map_err(|_| OtaError::Identity)?
                .is_some_and(|details| details.uid == policy.uid && details.identity == *driver))
        },
    )
}
fn consume_bound(
    policy: &FixturePolicy,
    point: Point,
    installation_id: &str,
    transaction_id: &str,
    own: &ProcessIdentity,
    compiled_version: &str,
    driver_alive: &dyn Fn(&ProcessIdentity) -> Result<bool, OtaError>,
) -> Result<bool, OtaError> {
    policy.validate_live().map_err(|_| OtaError::Identity)?;
    if installation_id.len() != 64
        || !installation_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !identifier(transaction_id)
        || !process_valid(own)
    {
        return Err(OtaError::Invalid);
    }
    let locks = PrivateDir::create(&policy.root.join("locks"))?;
    let _held = locks.lock_named("ledger-lock")?;
    policy.validate_live().map_err(|_| OtaError::Identity)?;
    let directory = PrivateDir::open(&policy.root)?;
    let before = directory.read("record.json", 65_536)?;
    let mut record: serde_json::Value =
        serde_json::from_slice(&before).map_err(|_| OtaError::Invalid)?;
    if record
        .get("exercise")
        .is_none_or(serde_json::Value::is_null)
    {
        return Ok(false);
    }
    let mut exercise: Exercise =
        serde_json::from_value(record["exercise"].clone()).map_err(|_| OtaError::Invalid)?;
    if exercise.schema != 1
        || exercise.installation_id != installation_id
        || !process_valid(&exercise.driver)
        || exercise
            .faults
            .iter()
            .map(|fault| fault.point)
            .collect::<Vec<_>>()
            != exercise.scenario.points()
        || exercise
            .transaction_id
            .as_deref()
            .is_some_and(|tx| tx != transaction_id)
    {
        return Err(OtaError::Identity);
    }
    for fault in &exercise.faults {
        if let Some(consumed) = &fault.consumed {
            if !process_valid(&consumed.process)
                || Some(&consumed.transaction_id) != exercise.transaction_id.as_ref()
            {
                return Err(OtaError::Invalid);
            }
        }
    }
    if exercise.state != State::Running {
        return Ok(false);
    }
    if point == Point::CandidateStartup
        && record["nativeFixture"]["candidateVersion"].as_str() != Some(compiled_version)
    {
        return Ok(false);
    }
    if !driver_alive(&exercise.driver)? {
        return Err(OtaError::Identity);
    }
    let index = exercise
        .faults
        .iter()
        .position(|fault| fault.point == point);
    let fire = index.is_some_and(|index| exercise.faults[index].consumed.is_none());
    if exercise.transaction_id.is_some() && !fire {
        return Ok(false);
    }
    if let Some(index) = index {
        if exercise.faults[..index]
            .iter()
            .any(|fault| fault.consumed.is_none())
        {
            return Err(OtaError::Invalid);
        }
        if fire {
            exercise.faults[index].consumed = Some(Consumption {
                process: own.clone(),
                transaction_id: transaction_id.to_owned(),
            });
        }
    }
    exercise.transaction_id = Some(transaction_id.to_owned());
    record["exercise"] = serde_json::to_value(exercise).map_err(|_| OtaError::Invalid)?;
    let next = serde_json::to_vec(&record).map_err(|_| OtaError::Invalid)?;
    if next.len() > 65_536 {
        return Err(OtaError::Invalid);
    }
    directory.replace_exact("record.json", &before, &next)?;
    Ok(fire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ota::{fixture_policy::FixturePolicy, native::ProcessIdentity};
    use std::os::unix::fs::{symlink, PermissionsExt};
    struct Fixture {
        _temp: tempfile::TempDir,
        policy: FixturePolicy,
        driver: ProcessIdentity,
        own: ProcessIdentity,
    }
    impl Fixture {
        fn new(scenario: &str, points: &[&str]) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let parent = temp.path().canonicalize().unwrap().join(".work/live/fault");
            let root = parent.join("ota");
            let home = parent.join("home");
            for path in [&parent, &root, &home] {
                std::fs::create_dir_all(path).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            let nonce = "a".repeat(32);
            let policy = FixturePolicy {
                schema: 1,
                root: root.clone(),
                nonce: nonce.clone(),
                home: home.clone(),
                port: 49321,
                current_app: root.join("current.app"),
                service_label: format!("com.pacer.live.{nonce}.service"),
                recovery_label: format!("com.pacer.live.{nonce}.recovery"),
                uid: unsafe { libc::getuid() },
            };
            let driver = ProcessIdentity {
                pid: 123,
                boot_id: "boot".into(),
                birth: "1:1".into(),
            };
            let own = ProcessIdentity {
                pid: 456,
                boot_id: "boot".into(),
                birth: "2:2".into(),
            };
            let record = serde_json::json!({"schema":1,"phase":"prepared","root":root,"nonce":nonce,"pacerHome":home,"innerPort":49321,"currentApp":policy.current_app,"serviceLabel":policy.service_label,"recoveryLabel":policy.recovery_label,"ownerUid":policy.uid,"nativeFixture":{"candidateVersion":"0.2.4"},"exercise":{"schema":1,"scenario":scenario,"state":"running","driver":driver,"installationId":"a".repeat(64),"transactionId":null,"faults":points.iter().map(|point|serde_json::json!({"point":point,"consumed":null})).collect::<Vec<_>>()}});
            let f = Self {
                _temp: temp,
                policy,
                driver,
                own,
            };
            f.write(record);
            f
        }
        fn read(&self) -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(self.policy.root.join("record.json")).unwrap())
                .unwrap()
        }
        fn write(&self, value: serde_json::Value) {
            let path = self.policy.root.join("record.json");
            std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        fn consume(
            &self,
            point: Point,
            version: &str,
            alive: bool,
        ) -> Result<bool, crate::ota::OtaError> {
            consume_bound(
                &self.policy,
                point,
                &"a".repeat(64),
                "transaction-1",
                &self.own,
                version,
                &|driver| Ok(alive && driver == &self.driver),
            )
        }
    }
    #[test]
    fn consumes_once_and_binds_only_first_transaction() {
        let f = Fixture::new("helper-crash", &["authorized"]);
        assert_eq!(f.consume(Point::Authorized, "0.2.3", true), Ok(true));
        let after = f.read();
        assert_eq!(after["exercise"]["transactionId"], "transaction-1");
        assert_eq!(
            after["exercise"]["faults"][0]["consumed"]["process"]["pid"],
            456
        );
        assert_eq!(f.consume(Point::Authorized, "0.2.3", true), Ok(false));
        assert_eq!(f.read(), after);
        assert!(consume_bound(
            &f.policy,
            Point::Authorized,
            &"a".repeat(64),
            "other",
            &f.own,
            "0.2.3",
            &|_| Ok(true)
        )
        .is_err());
        assert_eq!(f.read(), after);
    }
    #[test]
    fn upgrade_binds_validated_transaction_without_firing_a_fault() {
        let f = Fixture::new("upgrade", &[]);
        assert_eq!(f.consume(Point::Authorized, "0.2.3", true), Ok(false));
        assert_eq!(f.read()["exercise"]["transactionId"], "transaction-1");
    }
    #[test]
    fn candidate_failure_cannot_fire_in_rollback_shell() {
        let f = Fixture::new("restore-failure", &["candidate-startup", "restore"]);
        assert_eq!(f.consume(Point::CandidateStartup, "0.2.3", true), Ok(false));
        assert!(f.read()["exercise"]["faults"][0]["consumed"].is_null());
        assert_eq!(f.consume(Point::CandidateStartup, "0.2.4", true), Ok(true));
        assert_eq!(f.consume(Point::Restore, "0.2.3", true), Ok(true));
    }
    #[test]
    fn refuses_unknown_scenario_wrong_points_driver_and_identity() {
        for (scenario, points) in [
            ("arbitrary", vec!["authorized"]),
            ("helper-crash", vec!["installed"]),
            ("helper-crash", vec!["authorized", "authorized"]),
        ] {
            let f = Fixture::new(scenario, &points);
            let before = f.read();
            assert!(f.consume(Point::Authorized, "0.2.3", true).is_err());
            assert_eq!(f.read(), before);
        }
        let f = Fixture::new("interrupted-install", &["installed"]);
        let before = f.read();
        assert!(f.consume(Point::Installed, "0.2.3", false).is_err());
        assert_eq!(f.read(), before);
        assert!(consume_bound(
            &f.policy,
            Point::Installed,
            &"b".repeat(64),
            "transaction-1",
            &f.own,
            "0.2.3",
            &|_| Ok(true)
        )
        .is_err());
        assert_eq!(f.read(), before);
    }
    #[test]
    fn refuses_redirected_record_and_contended_ledger() {
        let f = Fixture::new("helper-crash", &["authorized"]);
        let locks =
            crate::ota::platform_fs::PrivateDir::create(&f.policy.root.join("locks")).unwrap();
        let held = locks.lock_named("ledger-lock").unwrap();
        assert!(f.consume(Point::Authorized, "0.2.3", true).is_err());
        drop(held);
        let path = f.policy.root.join("record.json");
        let moved = f.policy.root.join("saved.json");
        std::fs::rename(&path, &moved).unwrap();
        symlink(&moved, &path).unwrap();
        assert!(f.consume(Point::Authorized, "0.2.3", true).is_err());
    }
    #[test]
    fn missing_explicit_null_markers_are_not_armed_faults() {
        for field in ["transactionId", "consumed"] {
            let f = Fixture::new("helper-crash", &["authorized"]);
            let mut record = f.read();
            if field == "transactionId" {
                record["exercise"].as_object_mut().unwrap().remove(field);
            } else {
                record["exercise"]["faults"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
            }
            f.write(record.clone());
            assert!(f.consume(Point::Authorized, "0.2.3", true).is_err());
            assert_eq!(f.read(), record);
        }
    }
}
