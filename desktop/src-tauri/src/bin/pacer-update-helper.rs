fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        Some("--pacer-identity") => {
            let mut identity = pacer_desktop::ota::trust::build_identity();
            identity.as_object_mut().unwrap().extend(
                serde_json::json!({
                    "schema": 1, "role": "update-helper", "bundleId": "dev.pacer.desktop",
                    "version": env!("CARGO_PKG_VERSION"), "arch": std::env::consts::ARCH,
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            println!("{identity}");
        }
        #[cfg(all(target_os = "macos", feature = "ota-fixture"))]
        Some("--ota-fixture-inspect")
        | Some("--ota-fixture-retire")
        | Some("--ota-fixture-attach")
        | Some("--ota-fixture-attach-standard")
        | Some("--ota-fixture-attach-takeover")
        | Some("--ota-fixture-refresh-takeover") => {
            let result = (|| {
                if std::env::args().len() != 2 {
                    return Err(pacer_desktop::ota::OtaError::Invalid);
                }
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| pacer_desktop::ota::OtaError::Unavailable)?;
                match std::env::args().nth(1).as_deref() {
                    Some("--ota-fixture-attach")
                    | Some("--ota-fixture-attach-standard")
                    | Some("--ota-fixture-attach-takeover") => {
                        let mode = std::env::args().nth(1);
                        runtime.block_on(pacer_desktop::ota::helper::fixture_attach(
                            mode.as_deref() == Some("--ota-fixture-attach-takeover"),
                            mode.as_deref() == Some("--ota-fixture-attach-standard"),
                        ))
                    }
                    Some("--ota-fixture-refresh-takeover") => runtime.block_on(
                        pacer_desktop::ota::helper::fixture_refresh_takeover(),
                    ),
                    mode => runtime.block_on(pacer_desktop::ota::helper::fixture_jobs(
                        mode == Some("--ota-fixture-retire"),
                    )),
                }
            })();
            match result {
                Ok(report) => println!("{report}"),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            }
        }
        Some("--ota-pipe")
        | Some("--ota-takeover")
        | Some("--ota-recover-takeover")
        | Some("--ota-recover")
        | Some("--ota-recover-adoption")
        | Some("--pacer-helper-runtime-test") => {
            if let Err(error) = run_native() {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        _ => {
            eprintln!("Native update transactions are not available in this build");
            std::process::exit(2);
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum NativeMode {
    Pipe,
    RuntimeTest,
    UpdateRecovery(String, String),
    AdoptionRecovery(String, String),
    Takeover,
    TakeoverRecovery(String),
}

/// A takeover recovery that found its transaction locked by a running helper
/// or recovery job changed nothing; the desktop waits and may run it again.
#[cfg(any(target_os = "macos", test))]
const BUSY_EXIT: i32 = 75;

#[cfg(any(target_os = "macos", test))]
fn native_exit_code(mode: &NativeMode, result: &Result<(), pacer_desktop::ota::OtaError>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(pacer_desktop::ota::OtaError::Busy) if matches!(mode, NativeMode::TakeoverRecovery(_)) => BUSY_EXIT,
        Err(_) => 1,
    }
}

#[cfg(any(target_os = "macos", test))]
fn native_mode(arguments: &[String]) -> Result<NativeMode, pacer_desktop::ota::OtaError> {
    match arguments {
        [mode] if mode == "--ota-pipe" => Ok(NativeMode::Pipe),
        [mode] if mode == "--ota-takeover" => Ok(NativeMode::Takeover),
        [mode, tx] if mode == "--ota-recover-takeover" => {
            Ok(NativeMode::TakeoverRecovery(tx.clone()))
        }
        [mode] if mode == "--pacer-helper-runtime-test" => Ok(NativeMode::RuntimeTest),
        [mode, id, tx] if mode == "--ota-recover" => {
            Ok(NativeMode::UpdateRecovery(id.clone(), tx.clone()))
        }
        [mode, id, tx] if mode == "--ota-recover-adoption" => {
            Ok(NativeMode::AdoptionRecovery(id.clone(), tx.clone()))
        }
        _ => Err(pacer_desktop::ota::OtaError::Invalid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_takeover_recovery_exits_with_a_temporary_failure() {
        use pacer_desktop::ota::OtaError;
        let recovery = NativeMode::TakeoverRecovery("tx".into());
        assert_eq!(native_exit_code(&recovery, &Ok(())), 0);
        assert_eq!(native_exit_code(&recovery, &Err(OtaError::Busy)), BUSY_EXIT);
        assert_eq!(native_exit_code(&recovery, &Err(OtaError::Identity)), 1);
        assert_eq!(native_exit_code(&NativeMode::Takeover, &Err(OtaError::Busy)), 1);
    }
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).into()).collect()
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn helper_accepts_launchd_owned_process_group() {
        // Only async-signal-safe calls run in the forked child. launchd gives
        // jobs their own process group without making them session leaders.
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            if unsafe { libc::setpgid(0, 0) } != 0 {
                unsafe { libc::_exit(90) };
            }
            let accepted = detach_helper().is_ok();
            unsafe { libc::_exit(if accepted { 0 } else { 91 }) };
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn helper_initializes_updater_with_compiled_trust_configuration() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let mut context = mock_context(noop_assets());
        configure_helper(context.config_mut(), "test-public-key");
        let app = mock_builder()
            .plugin(
                tauri_plugin_updater::Builder::new()
                    .pubkey("test-public-key")
                    .build(),
            )
            .build(context);
        assert!(
            app.is_ok(),
            "updater initialization failed: {:?}",
            app.err()
        );
    }
    #[test]
    fn native_mode_keeps_service_recovery_separate_and_rejects_extra_arguments() {
        assert_eq!(native_mode(&args(&["--ota-pipe"])), Ok(NativeMode::Pipe));
        assert_eq!(
            native_mode(&args(&["--ota-takeover"])),
            Ok(NativeMode::Takeover)
        );
        assert_eq!(
            native_mode(&args(&["--ota-recover-takeover", "transaction"])),
            Ok(NativeMode::TakeoverRecovery("transaction".into()))
        );
        assert_eq!(
            native_mode(&args(&["--pacer-helper-runtime-test"])),
            Ok(NativeMode::RuntimeTest)
        );
        assert_eq!(
            native_mode(&args(&["--ota-recover", "installation", "transaction"])),
            Ok(NativeMode::UpdateRecovery(
                "installation".into(),
                "transaction".into()
            ))
        );
        assert_eq!(
            native_mode(&args(&[
                "--ota-recover-adoption",
                "installation",
                "transaction"
            ])),
            Ok(NativeMode::AdoptionRecovery(
                "installation".into(),
                "transaction".into()
            ))
        );
        for values in [
            vec!["--ota-pipe", "extra"],
            vec!["--pacer-helper-runtime-test", "extra"],
            vec!["--ota-recover"],
            vec!["--ota-recover-adoption", "id"],
            vec!["--ota-recover-adoption", "id", "tx", "extra"],
            vec!["--ota-takeover", "extra"],
            vec!["--ota-recover-takeover"],
            vec!["--ota-recover-takeover", "tx", "extra"],
            vec!["--other"],
        ] {
            assert!(native_mode(&args(&values)).is_err());
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn run_native() -> Result<(), pacer_desktop::ota::OtaError> {
    Err(pacer_desktop::ota::OtaError::Unavailable)
}

#[cfg(target_os = "macos")]
fn configure_helper(config: &mut tauri::Config, public_key: &str) {
    config.identifier = pacer_desktop::ota::trust::HELPER_ID.into();
    config.app.windows.clear();
    // Tauri deserializes plugin configuration before the builder's key override
    // runs. Supply the same compiled trust root at both initialization boundaries.
    config.plugins.0.insert(
        "updater".into(),
        serde_json::json!({"pubkey": public_key, "requireSignedVersion": true}),
    );
}

#[cfg(target_os = "macos")]
fn detach_helper() -> Result<(), pacer_desktop::ota::OtaError> {
    // Pipe children leave their service's process group. launchd already gives
    // its jobs a separate group, so setsid returns EPERM for that group leader;
    // it does not need another session to survive the desktop/service exits.
    if unsafe { libc::setsid() } < 0 && unsafe { libc::getpgrp() } != unsafe { libc::getpid() } {
        return Err(pacer_desktop::ota::OtaError::Io);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_native() -> Result<(), pacer_desktop::ota::OtaError> {
    use pacer_desktop::ota::{helper, trust::ReleaseTrust, OtaError};
    let trust = ReleaseTrust::configured().ok_or(OtaError::Unavailable)?;
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let mode = native_mode(&arguments)?;
    // Independent process group and event loop survive desktop and service exits.
    // No shell, elevation, autostart or single-instance plugin runs in the helper.
    detach_helper()?;
    let mut context = tauri::generate_context!();
    configure_helper(context.config_mut(), trust.public_key());
    let mut app = tauri::Builder::<tauri::Wry>::default()
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(trust.public_key())
                .build(),
        )
        .build(context)
        .map_err(|_| OtaError::Unavailable)?;
    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    let mut execution = Some((trust, mode));
    app.run(move |handle, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            if let Some((trust, mode)) = execution.take() {
                if mode == NativeMode::RuntimeTest {
                    // Reaching Ready proves real native runtime and plugin setup.
                    // No service connection, update command or recovery is opened.
                    println!("{}", serde_json::json!({"schema":1,"role":"update-helper","version":env!("CARGO_PKG_VERSION"),"arch":std::env::consts::ARCH,"runtime":"tauri-updater","verified":true}));
                    handle.exit(0);
                    return;
                }
                let handle = handle.clone();
                std::thread::spawn(move || {
                    let exit_mode = mode.clone();
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let runtime = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .map_err(|_| OtaError::Unavailable)?;
                        runtime.block_on(async {
                            match mode {
                                NativeMode::RuntimeTest => unreachable!(),
                                NativeMode::UpdateRecovery(id, tx) => {
                                    helper::run_recovery(&handle, trust, &id, &tx).await
                                }
                                NativeMode::AdoptionRecovery(id, tx) => {
                                    helper::run_adoption_recovery(trust, &id, &tx).await
                                }
                                NativeMode::Takeover => pacer_desktop::ota::helper_takeover::run_takeover(trust),
                                NativeMode::TakeoverRecovery(tx) => pacer_desktop::ota::helper_takeover::run_recovery(trust, &tx),
                                NativeMode::Pipe => {
                                    helper::run_pipe(
                                        &handle,
                                        trust,
                                        &mut helper::PipeInput::new()?,
                                        std::io::stdout(),
                                    )
                                    .await
                                }
                            }
                        })
                    }))
                    .unwrap_or(Err(OtaError::RecoveryFailed));
                    if let Err(error) = &result {
                        eprintln!("{error}");
                    }
                    handle.exit(native_exit_code(&exit_mode, &result));
                });
            }
        }
    });
    Ok(())
}
