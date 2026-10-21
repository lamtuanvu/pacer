#[path = "src/ota/fixture_policy.rs"]
#[allow(dead_code)]
mod fixture_policy;
#[path = "src/ota/trust_config.rs"]
mod trust_config;

fn main() {
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
        ]),
    ))
    .expect("build desktop shell");
}
