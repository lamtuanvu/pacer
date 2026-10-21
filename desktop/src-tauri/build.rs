fn main() {
    // Capture diagnostics must not raise the shell's existing macOS deployment floor.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        build_permission_helper();
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
            "native_validation_setup",
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
    assert!(
        compiled.status.success(),
        "permission helper compile failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let signed = Command::new("/usr/bin/codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--identifier",
            "dev.pacer.permission-setup",
        ])
        .arg(&temporary)
        .output()
        .expect("codesign permission helper");
    assert!(
        signed.status.success(),
        "permission helper signing failed: {}",
        String::from_utf8_lossy(&signed.stderr)
    );
    std::fs::rename(&temporary, &output).expect("stage permission helper");
    println!(
        "cargo:rustc-env=PACER_PERMISSION_HELPER={}",
        output.display()
    );
}
