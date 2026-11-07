//! Request OS-owned approvals through native APIs. No shell commands or surrogate dialogs.
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Permission {
    Unknown = 0,
    Allowed = 1,
    Denied = 2,
}
static NOTIFICATIONS: AtomicU8 = AtomicU8::new(Permission::Unknown as u8);

/// Only an explicit OS denial opts the desktop out, so the service can fall back to its
/// notifier plugin; an undetermined or unbundled launch keeps presenting.
pub fn notifications_presentable() -> bool {
    NOTIFICATIONS.load(Ordering::SeqCst) != Permission::Denied as u8
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn record_notifications(permission: Permission) {
    let previous = NOTIFICATIONS.swap(permission as u8, Ordering::SeqCst);
    if previous != permission as u8 {
        desktop_log!("pacer approvals: notification permission {permission:?}");
    }
}

/// Maps `UNAuthorizationStatus`; `NotDetermined` and unknown values keep the last answer.
#[cfg_attr(
    not(all(target_os = "macos", not(feature = "ota-fixture"))),
    allow(dead_code)
)]
fn permission_for_status(status: isize) -> Option<Permission> {
    match status {
        1 => Some(Permission::Denied),
        2..=4 => Some(Permission::Allowed),
        _ => None,
    }
}

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
        record_notifications(if granted.as_bool() {
            Permission::Allowed
        } else {
            Permission::Denied
        });
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge,
            &complete,
        );
}

/// Re-reads the notification setting so a change in System Settings reaches the service.
#[cfg(all(target_os = "macos", not(feature = "ota-fixture")))]
pub fn refresh_notifications() {
    use block2::RcBlock;
    use objc2_foundation::NSBundle;
    use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};
    use std::ptr::NonNull;
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return;
    }
    let complete = RcBlock::new(|settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        if let Some(permission) = permission_for_status(status.0) {
            record_notifications(permission);
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&complete);
}
#[cfg(not(all(target_os = "macos", not(feature = "ota-fixture"))))]
pub fn refresh_notifications() {}

#[cfg(target_os = "macos")]
pub fn launch_at_login_enabled() -> Option<bool> {
    use objc2::runtime::AnyClass;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    AnyClass::get(c"SMAppService")?;
    Some(unsafe { SMAppService::mainAppService().status() == SMAppServiceStatus::Enabled })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_denial_stops_presenting() {
        assert!(notifications_presentable());
        record_notifications(Permission::Denied);
        assert!(!notifications_presentable());
        record_notifications(Permission::Allowed);
        assert!(notifications_presentable());
    }

    #[test]
    fn authorization_status_maps_to_permission() {
        assert_eq!(permission_for_status(0), None);
        assert_eq!(permission_for_status(1), Some(Permission::Denied));
        for status in 2..=4 {
            assert_eq!(permission_for_status(status), Some(Permission::Allowed));
        }
        assert_eq!(permission_for_status(9), None);
    }
}
