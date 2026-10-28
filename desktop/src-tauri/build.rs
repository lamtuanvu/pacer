#[path = "src/ota/fixture_policy.rs"]
#[allow(dead_code)]
mod fixture_policy;
#[path = "src/ota/trust_config.rs"]
mod trust_config;

fn main() {
    // Capture diagnostics must not raise the shell's existing macOS deployment floor.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        build_permission_helper();
    }
    println!("cargo:rerun-if-env-changed=PACER_OTA_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=PACER_APPLE_TEAM_ID");
    println!("cargo:rerun-if-env-changed=PACER_SIGNING_CERT_SHA1");
    println!("cargo:rerun-if-env-changed=PACER_OTA_FIXTURE_POLICY");
    let production = std::env::var_os("CARGO_FEATURE_OTA_PRODUCTION").is_some();
    let fixture = std::env::var_os("CARGO_FEATURE_OTA_FIXTURE").is_some();
    assert!(
        !(production && fixture),
        "ota-production and ota-fixture are mutually exclusive"
    );
    if production {
        assert_eq!(
            std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
            Ok("macos"),
            "Production OTA requires macOS"
        );
        let key = std::env::var("PACER_OTA_PUBLIC_KEY")
            .expect("Production OTA requires PACER_OTA_PUBLIC_KEY");
        let pin = |name| std::env::var(name).ok().filter(|v: &String| !v.is_empty());
        let team = pin("PACER_APPLE_TEAM_ID");
        let cert = pin("PACER_SIGNING_CERT_SHA1");
        trust_config::validate_key(&key).expect("Invalid public OTA key");
        trust_config::validate_signers(team.as_deref(), cert.as_deref()).expect(
            "Production OTA requires a valid PACER_APPLE_TEAM_ID and/or PACER_SIGNING_CERT_SHA1",
        );
        println!("cargo:rustc-env=PACER_OTA_PUBLIC_KEY={key}");
        if let Some(team) = team {
            println!("cargo:rustc-env=PACER_APPLE_TEAM_ID={team}");
        }
        if let Some(cert) = cert {
            println!("cargo:rustc-env=PACER_SIGNING_CERT_SHA1={cert}");
        }
    }
    if fixture {
        assert_eq!(
            std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
            Ok("macos"),
            "Native OTA fixtures require macOS"
        );
        let key = std::env::var("PACER_OTA_PUBLIC_KEY")
            .expect("Fixture OTA requires a disposable public key");
        trust_config::validate(&key, "FIXTURE000").expect("Invalid fixture public key");
        let policy = std::env::var("PACER_OTA_FIXTURE_POLICY")
            .expect("Fixture OTA requires a compile-time harness lease");
        assert!(
            !policy.contains(['\r', '\n']),
            "Fixture policy must be one JSON line"
        );
        fixture_policy::FixturePolicy::parse(&policy)
            .expect("Invalid fixture lease")
            .validate_build(&key)
            .expect("Fixture lease is not a private build or prepared sandbox");
        println!("cargo:rustc-env=PACER_OTA_PUBLIC_KEY={key}");
        println!("cargo:rustc-env=PACER_OTA_FIXTURE_POLICY={policy}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "client_control",
            "setLaunchAtLogin",
            "setTheme",
            "notifyRoute",
            "tray_resize",
            "tray_open",
            "tray_hide",
            "app_quit",
            "session_expired",
            "session_ready",
            "desktop_version",
            "host_file_actions",
            "open_session_file",
            "rounded_window_supported",
            "native_titlebar_supported",
            "desktop_update_connection",
            "native_validation_setup",
            "windowMinimize",
            "windowToggleMaximize",
            "windowClose",
        ]),
    ))
    .expect("build desktop shell");
}

fn build_permission_helper() {
    use std::{env, path::PathBuf, process::Command};
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let sources = [
        root.join("../native/permission-chip.swift"),
        root.join("../native/permission-setup-main.swift"),
    ];
    for source in &sources {
        println!("cargo:rerun-if-changed={}", source.display());
    }
    let target = env::var("TARGET").expect("Rust target");
    let arch = if target.starts_with("aarch64-") {
        "arm64"
    } else if target.starts_with("x86_64-") {
        "x86_64"
    } else {
        panic!("Unsupported macOS permission helper architecture");
    };
    let directory = root.join("binaries");
    std::fs::create_dir_all(&directory).expect("sidecar directory");
    let output = directory.join(format!("pacer-permission-setup-{target}"));
    let temporary = output.with_extension(format!("tmp-{}", std::process::id()));
    let compiled = Command::new("/usr/bin/swiftc")
        .arg("-parse-as-library")
        .arg("-O")
        .arg("-target")
        .arg(format!("{arch}-apple-macosx11.0"))
        .args(&sources)
        .arg("-o")
        .arg(&temporary)
        .output()
        .expect("Swift compiler is required for the macOS permission helper");
    assert!(compiled.status.success(), "permission helper compile failed: {}", String::from_utf8_lossy(&compiled.stderr));
    let signed = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--identifier", "dev.pacer.permission-setup"])
        .arg(&temporary)
        .output()
        .expect("codesign permission helper");
    assert!(signed.status.success(), "permission helper signing failed: {}", String::from_utf8_lossy(&signed.stderr));
    std::fs::rename(&temporary, &output).expect("stage permission helper");
    println!("cargo:rustc-env=PACER_PERMISSION_HELPER={}", output.display());
}
