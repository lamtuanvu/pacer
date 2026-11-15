//! Request OS-owned approvals through native APIs. No shell commands or surrogate dialogs.
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
#[cfg_attr(
    not(all(target_os = "macos", not(feature = "ota-fixture"))),
    allow(dead_code)
)]
enum Permission {
    Unknown = 0,
    Allowed = 1,
    Denied = 2,
}
static NOTIFICATIONS: AtomicU8 = AtomicU8::new(Permission::Unknown as u8);
static NOTIFICATIONS_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();
static NOTIFICATION_PERMISSION_STATE: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(String::from("unsupported")));
static NOTIFICATION_ALERTS_STATE: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(String::from("none")));

/// Only an explicit OS denial opts the desktop out, so the service can fall back to its
/// notifier plugin; an undetermined or unbundled launch keeps presenting.
pub fn notifications_presentable() -> bool {
    NOTIFICATIONS.load(Ordering::SeqCst) != Permission::Denied as u8
}

pub fn notification_permission_state() -> String {
    NOTIFICATION_PERMISSION_STATE
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| String::from("unsupported"))
}

pub fn notification_alerts_state() -> String {
    NOTIFICATION_ALERTS_STATE
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| String::from("none"))
}

pub fn notification_permission_state_for_status(status: isize) -> &'static str {
    match status {
        0 => "not_determined",
        1 => "denied",
        2 => "authorized",
        3 => "provisional",
        4 => "ephemeral",
        _ => "not_determined",
    }
}

pub fn notification_alerts_state_for_style(style: isize) -> &'static str {
    match style {
        1 => "banner",
        2 => "alert",
        _ => "none",
    }
}

/// Resolves after the recorded permission changes, including a change made before the call.
pub async fn notifications_changed() {
    NOTIFICATIONS_CHANGED.notified().await;
}

#[cfg_attr(
    not(all(target_os = "macos", not(feature = "ota-fixture"))),
    allow(dead_code)
)]
fn record_notifications(permission: Permission) {
    let previous = NOTIFICATIONS.swap(permission as u8, Ordering::SeqCst);
    if previous != permission as u8 {
        desktop_log!("pacer approvals: notification permission {permission:?}");
        NOTIFICATIONS_CHANGED.notify_one();
    }
}

fn record_permission_raw(value: &str) {
    if let Ok(mut state) = NOTIFICATION_PERMISSION_STATE.lock() {
        if *state != value {
            *state = value.to_string();
            NOTIFICATIONS_CHANGED.notify_one();
        }
    }
}

fn record_alerts_raw(value: &str) {
    if let Ok(mut state) = NOTIFICATION_ALERTS_STATE.lock() {
        if *state != value {
            *state = value.to_string();
            NOTIFICATIONS_CHANGED.notify_one();
        }
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
        if let Some(error) = unsafe { error.as_ref() } {
            desktop_log!(
                "pacer approvals: notification authorization error {}: {}",
                error.code(),
                error.localizedDescription()
            );
        }
        record_notifications(if granted.as_bool() {
            Permission::Allowed
        } else {
            Permission::Denied
        });
        record_permission_raw(if granted.as_bool() { "authorized" } else { "denied" });
        refresh_notifications();
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
        record_permission_raw("unsupported");
        record_alerts_raw("none");
        return;
    }
    let complete = RcBlock::new(|settings: NonNull<UNNotificationSettings>| {
        let settings = unsafe { settings.as_ref() };
        let status = settings.authorizationStatus();
        if let Some(permission) = permission_for_status(status.0) {
            record_notifications(permission);
        }
        record_permission_raw(notification_permission_state_for_status(status.0));
        let alert_style = settings.alertStyle();
        record_alerts_raw(notification_alerts_state_for_style(alert_style.0));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&complete);
}
#[cfg(all(target_os = "macos", not(feature = "ota-fixture")))]
pub fn request_notifications_then_refresh() {
    request_notifications();
}
#[cfg(not(all(target_os = "macos", not(feature = "ota-fixture"))))]
pub fn refresh_notifications() {}

#[cfg(not(target_os = "macos"))]
pub fn request_notifications_then_refresh() {}

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

    // The `NOTIFICATIONS_CHANGED` notify is a process-global, so every wake-up
    // assertion lives in one test; pure mapping tests stay separate.
    #[tokio::test]
    async fn notification_state_changes_wake_the_heartbeat() {
        use std::time::Duration;
        use tokio::time::timeout;
        assert!(notifications_presentable());
        record_notifications(Permission::Denied);
        assert!(!notifications_presentable());
        timeout(Duration::from_secs(1), notifications_changed())
            .await
            .expect("a permission change wakes the heartbeat");
        record_notifications(Permission::Denied);
        assert!(
            timeout(Duration::from_millis(20), notifications_changed())
                .await
                .is_err(),
            "an unchanged permission answer does not"
        );
        record_notifications(Permission::Allowed);
        assert!(notifications_presentable());
        timeout(Duration::from_secs(1), notifications_changed())
            .await
            .expect("a permission change wakes the heartbeat");
        record_permission_raw("not_determined");
        record_permission_raw("not_determined");
        timeout(Duration::from_millis(20), notifications_changed())
            .await
            .expect("a first raw permission state change wakes the heartbeat");
        assert!(
            timeout(Duration::from_millis(20), notifications_changed())
                .await
                .is_err(),
            "an unchanged raw permission answer does not wake it again"
        );
        record_alerts_raw("banner");
        timeout(Duration::from_secs(1), notifications_changed())
            .await
            .expect("an alert-style change wakes the heartbeat");
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

    #[test]
    fn raw_permission_state_maps_every_authorization_status() {
        assert_eq!(notification_permission_state_for_status(0), "not_determined");
        assert_eq!(notification_permission_state_for_status(1), "denied");
        assert_eq!(notification_permission_state_for_status(2), "authorized");
        assert_eq!(notification_permission_state_for_status(3), "provisional");
        assert_eq!(notification_permission_state_for_status(4), "ephemeral");
        // Unknown statuses stay undetermined rather than inventing a state.
        assert_eq!(notification_permission_state_for_status(9), "not_determined");
        assert_eq!(notification_permission_state_for_status(-1), "not_determined");
    }

    #[test]
    fn raw_alert_style_maps_every_style() {
        assert_eq!(notification_alerts_state_for_style(0), "none");
        assert_eq!(notification_alerts_state_for_style(1), "banner");
        assert_eq!(notification_alerts_state_for_style(2), "alert");
        // Unknown styles fall back to none (quiet, no banners).
        assert_eq!(notification_alerts_state_for_style(9), "none");
    }
}
