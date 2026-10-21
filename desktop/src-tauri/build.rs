fn main() {
    // Capture diagnostics must not raise the shell's existing macOS deployment floor.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
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
        ]),
    ))
    .expect("build desktop shell");
}
