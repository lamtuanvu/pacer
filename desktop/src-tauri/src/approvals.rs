//! Request OS-owned approvals through native APIs. No shell commands or surrogate dialogs.
#[cfg(target_os = "macos")]
pub fn launch_at_login(enabled: bool) -> Option<Result<(), String>> {
    use objc2::runtime::AnyClass;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    // SMAppService is available from macOS 13. Older supported systems use the
    // autostart plugin's LaunchAgent implementation.
    AnyClass::get(c"SMAppService")?;
    unsafe {
        let service = SMAppService::mainAppService();
        let status = service.status();
        if (enabled && status == SMAppServiceStatus::Enabled)
            || (!enabled && status == SMAppServiceStatus::NotRegistered)
        {
            return Some(Ok(()));
        }
        let result = if enabled {
            service.registerAndReturnError()
        } else {
            service.unregisterAndReturnError()
        };
        desktop_log!(
            "pacer approvals: login item enabled={enabled}, status={:?}",
            service.status()
        );
        Some(result.map_err(|error| error.localizedDescription().to_string()))
    }
}

#[cfg(target_os = "macos")]
pub fn request_notifications() {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError};
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    // UNUserNotificationCenter raises an exception for an unbundled dev executable.
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        desktop_log!("pacer approvals: notification authorization requires an app bundle");
        return;
    }
    let complete = RcBlock::new(|granted: Bool, error: *mut NSError| {
        desktop_log!(
            "pacer approvals: notifications granted={}, error={}",
            granted.as_bool(),
            !error.is_null()
        );
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge,
            &complete,
        );
}
