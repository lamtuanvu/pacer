//! Standalone desktop-authorized takeover and launchd recovery entry points.
#[cfg(target_os = "macos")]
use crate::ota::{
    control, native,
    platform_fs::{NativeLocks, PrivateDir},
    takeover::{
        engine,
        journal::{TakeoverManifest, TakeoverState, TakeoverStore},
        platform::NativeTakeoverPlatform,
    },
    trust::{CodeRole, ReleaseTrust},
    OtaError,
};
#[cfg(target_os = "macos")]
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::{
    os::fd::FromRawFd,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
};

#[cfg(target_os = "macos")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    state: TakeoverState,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
fn config_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support")
        .join(crate::ota::trust::APP_ID)
}

#[cfg(target_os = "macos")]
fn lock_transaction(trust: &ReleaseTrust, m: &TakeoverManifest) -> Result<NativeLocks, OtaError> {
    let app = m
        .bundled_cli
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or(OtaError::Invalid)?;
    let locks = if let Some(policy) = trust.fixture_policy() {
        if app != policy.current_app {
            return Err(OtaError::Identity);
        }
        policy.root.join("locks")
    } else {
        PathBuf::from(format!("/private/tmp/pacer-ota-{}", unsafe {
            libc::geteuid()
        }))
    };
    PrivateDir::create(&locks)?.acquire_locks(app, &m.candidate.home)
}

#[cfg(target_os = "macos")]
pub fn run_takeover(trust: ReleaseTrust) -> Result<(), OtaError> {
    // fd 3 is an inherited socketpair endpoint, never a path supplied by the peer.
    let mut channel = unsafe { UnixStream::from_raw_fd(3) };
    let manifest: TakeoverManifest = control::read_frame(&mut channel)?;
    crate::ota::helper::verify_takeover_parent(&manifest, &trust)?;
    let home = &manifest.candidate.home;
    let user_home = crate::ota::platform::user_home(&trust)?;
    // Lock first: a contended or refused attempt leaves no transaction behind.
    let _locks = lock_transaction(&trust, &manifest)?;
    let store = TakeoverStore::create(home, &manifest)?;
    let platform = NativeTakeoverPlatform::new(trust, user_home.clone(), config_dir(&user_home))?;
    let _ = control::write_frame(
        &mut channel,
        &Progress {
            state: TakeoverState::Prepared,
            error: None,
        },
    );
    let outcome = engine::execute_with_progress(&store, &platform, &mut |state| {
        let _ = control::write_frame(&mut channel, &Progress { state, error: None });
    });
    let journal = store.journal()?;
    let state = journal.state;
    // Only short public reason codes cross the channel; never paths or messages.
    let error = journal.error.or_else(|| {
        outcome.as_ref().err().map(|error| {
            format!(
                "helper:{}",
                serde_json::to_value(error)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unknown".into())
            )
        })
    });
    let _ = control::write_frame(&mut channel, &Progress { state, error });
    outcome.map(|_| ())
}

/// The recovery job runs the transaction's helper copy. The desktop runs the
/// app's own bundled helper once for a transaction whose job never loaded.
/// Either way the process signature is verified before anything happens.
#[cfg(target_os = "macos")]
fn recovery_program_allowed(exe: &Path, copy: &Path, m: &TakeoverManifest) -> bool {
    let bundled = m
        .bundled_cli
        .parent()
        .map(|resources| resources.join("pacer-update-helper"));
    exe == copy
        || bundled.is_some_and(|bundled| {
            exe == bundled || bundled.canonicalize().is_ok_and(|bundled| exe == bundled)
        })
}

#[cfg(target_os = "macos")]
pub fn run_recovery(trust: ReleaseTrust, tx: &str) -> Result<(), OtaError> {
    let home = PathBuf::from(std::env::var_os("PACER_HOME").ok_or(OtaError::Invalid)?);
    let store = TakeoverStore::open(&home, tx)?;
    let helper = home
        .join("desktop-updates/native/takeover")
        .join(tx)
        .join("pacer-update-helper");
    let exe = std::env::current_exe()
        .map_err(|_| OtaError::Identity)?
        .canonicalize()
        .map_err(|_| OtaError::Identity)?;
    if !recovery_program_allowed(&exe, &helper, store.manifest()) {
        return Err(OtaError::Identity);
    }
    let own = native::process_details(unsafe { libc::getpid() } as u32)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    let _locks = lock_transaction(&trust, store.manifest())?;
    let user_home = crate::ota::platform::user_home(&trust)?;
    let platform = NativeTakeoverPlatform::new(trust, user_home.clone(), config_dir(&user_home))?;
    // A terminal state is durable once recover returns, and the job is retired.
    // Recovery failure is reported by the desktop from the retained journal; a
    // failing exit here would only make launchd relaunch the job.
    engine::recover(&store, &platform).map(|_| ())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn recovery_runs_from_the_transaction_copy_or_the_apps_bundled_helper() {
        let manifest: TakeoverManifest = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/desktop-update/takeover-manifest.json"
        )))
        .unwrap();
        let copy =
            Path::new("/fixture/home/desktop-updates/native/takeover/tx/pacer-update-helper");
        let bundled = manifest
            .bundled_cli
            .parent()
            .unwrap()
            .join("pacer-update-helper");
        assert!(recovery_program_allowed(copy, copy, &manifest));
        assert!(recovery_program_allowed(&bundled, copy, &manifest));
        assert!(!recovery_program_allowed(
            Path::new("/tmp/pacer-update-helper"),
            copy,
            &manifest
        ));
        assert!(!recovery_program_allowed(
            &manifest.bundled_cli,
            copy,
            &manifest
        ));
    }
    #[test]
    fn parent_pid_and_signature_must_match_desktop_authorization() {
        let mut manifest: TakeoverManifest = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/desktop-update/takeover-manifest.json"
        )))
        .unwrap();
        let mut packet = vec![0u8; 42];
        packet[..2].copy_from_slice(b"Ed");
        packet[10..].fill(7);
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.encode(format!(
            "untrusted comment: fixture\n{}\n",
            base64::engine::general_purpose::STANDARD.encode(packet)
        ));
        let trust = ReleaseTrust::from_production(&key, Some("ABCDE12345"), None).unwrap();
        assert_eq!(
            crate::ota::helper::verify_takeover_parent(&manifest, &trust),
            Err(OtaError::Identity)
        );
        let parent = native::process_details(unsafe { libc::getppid() } as u32)
            .unwrap()
            .unwrap();
        manifest.desktop = parent.identity;
        assert_eq!(
            crate::ota::helper::verify_takeover_parent(&manifest, &trust),
            Err(OtaError::Identity)
        );
    }
    #[test]
    fn authorization_frame_rejects_malformed_input() {
        use std::io::Write;
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.write_all(&1u32.to_be_bytes()).unwrap();
        writer.write_all(b"{").unwrap();
        assert_eq!(
            control::read_frame::<TakeoverManifest>(&mut reader).err(),
            Some(OtaError::Invalid)
        );
    }
    #[test]
    fn valid_authorization_frame_drives_engine_without_effects_on_drift() {
        struct Reject;
        impl engine::TakeoverPlatform for Reject {
            fn awake_now(&self) -> Result<crate::ota::AwakeStamp, OtaError> {
                crate::ota::native::awake_now().map_err(|_| OtaError::Io)
            }
            fn redetect(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                Err(OtaError::Identity)
            }
            fn arm_recovery(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn stop_original(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn switch_registration(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn launch_managed(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn verify_managed(
                &self,
                _: &TakeoverManifest,
                _: crate::ota::AwakeStamp,
            ) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn restore_registration(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn launch_original(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn verify_original(
                &self,
                _: &TakeoverManifest,
                _: crate::ota::AwakeStamp,
            ) -> Result<(), OtaError> {
                panic!("effect")
            }
            fn retire_recovery(&self, _: &TakeoverManifest) -> Result<(), OtaError> {
                panic!("effect")
            }
        }
        let manifest: TakeoverManifest = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/desktop-update/takeover-manifest.json"
        )))
        .unwrap();
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        control::write_frame(&mut writer, &manifest).unwrap();
        let received: TakeoverManifest = control::read_frame(&mut reader).unwrap();
        let home = tempfile::tempdir().unwrap();
        let store = TakeoverStore::create(home.path(), &received).unwrap();
        assert_eq!(
            engine::execute(&store, &Reject),
            Ok(TakeoverState::Restored)
        );
        let journal = store.journal().unwrap();
        assert!(journal.steps.is_empty());
        assert_eq!(journal.error.as_deref(), Some("redetect:identity"));
    }
    #[test]
    fn takeover_reads_the_desktop_config_of_this_build_flavour() {
        assert_eq!(
            config_dir(Path::new("/fixture/home")),
            Path::new("/fixture/home/Library/Application Support").join(crate::ota::trust::APP_ID)
        );
    }
    #[cfg(not(feature = "ota-fixture"))]
    #[test]
    fn release_takeover_reads_the_release_desktop_config() {
        assert_eq!(
            config_dir(Path::new("/h")),
            PathBuf::from("/h/Library/Application Support/dev.pacer.desktop")
        );
    }
}
