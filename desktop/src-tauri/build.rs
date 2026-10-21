fn main() {
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
