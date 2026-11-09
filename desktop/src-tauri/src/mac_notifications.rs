//! macOS notification presentation through UNUserNotificationCenter.
//!
//! tauri-plugin-notification (2.x) posts on macOS through notify-rust's
//! deprecated NSUserNotificationCenter, which never surfaces a banner for this
//! app even when notification permission is Allowed. Posting directly through
//! UNUserNotificationCenter (the same API approvals.rs authorizes with) makes
//! banners appear while the app is running and routes taps and buttons back
//! through the same Shell actions the plugin handler used.
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString,
};
use objc2_user_notifications::{
    UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// How many categories, buttons and route mappings stay live. Later
/// notifications reuse a category slot; older ones are dropped so a tap on
/// still-delivered banners never resolves to an id that no longer maps.
pub const CATEGORY_WINDOW: u64 = 32;

/// Identifier of the category a notification of ordinal `index` is posted
/// under. Stable and unique per notification so button ids inside the
/// category cannot be remapped by a later notification.
pub fn category_id(index: u64) -> String {
    format!("pacer-attention-{index}")
}

/// Identifier of the `button`th action inside `category`; this is the id a
/// button tap delivers to the notification center delegate.
pub fn action_id(category: &str, button: usize) -> String {
    format!("{category}-{button}")
}

/// The categories that must stay registered once a notification with this
/// newest index exists: the last [`CATEGORY_WINDOW`], oldest first.
pub fn retained_categories(newest: u64) -> Vec<String> {
    let from = newest.saturating_sub(CATEGORY_WINDOW - 1);
    (from..=newest).map(category_id).collect()
}

/// Pure extraction of the route the plugin stored in the extra payload; kept
/// separate from Objective-C plumbing so it is unit-testable.
pub(crate) fn route_from_user_info(user_info: &NSDictionary) -> Option<String> {
    let key = NSString::from_str("route");
    user_info
        .objectForKey(&*key)?
        .downcast::<NSString>()
        .ok()
        .map(|value| value.to_string())
}

fn route_user_info(route: &str) -> Retained<NSDictionary> {
    let key = NSString::from_str("route");
    let value = NSString::from_str(route);
    // SAFETY: key is an NSString, which is a valid object (copied) key.
    unsafe { NSDictionary::dictionaryWithObject_forKey(&*value, ProtocolObject::from_ref(&*key)) }
}

/// One posted category and the buttons it advertised; the app keeps the last
/// [`CATEGORY_WINDOW`] of these so `setNotificationCategories` can restore the
/// whole live set (it replaces the set rather than adding to it).
struct Category {
    id: String,
    actions: Vec<(String, String)>,
}

static NEXT_INDEX: AtomicU64 = AtomicU64::new(0);
static REGISTERED: Mutex<Vec<Category>> = Mutex::new(Vec::new());
/// Strong reference for the center's weak delegate property. Kept for the app
/// lifetime; installing it returns `&self` pointers that must stay valid.
static CENTER_DELEGATE: Mutex<Option<Retained<CenterDelegate>>> = Mutex::new(None);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

// Handles banners while pacer is frontmost and taps on posted banners.
// Delegate methods run on the main thread, where the existing Shell handlers
// operate.
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    struct CenterDelegate;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for CenterDelegate {}

    // SAFETY: UNUserNotificationCenterDelegate has no safety requirements; the
    // completion handlers below are always called exactly once.
    unsafe impl UNUserNotificationCenterDelegate for CenterDelegate {
        /// Present the banner and the list row with no sound even while pacer is
        /// the frontmost app (the default would suppress banners).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options =
                UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List;
            completion.call((options,));
        }

        /// A tap on the banner (default action) navigates to the route carried
        /// in userInfo; a tap on a button dispatches the Shell action it mapped
        /// to when it was posted.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            handle_response(response);
            completion.call(());
        }
    }
);

impl CenterDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc();
        // SAFETY: `init` is NSObject's initializer; the signature is correct.
        unsafe { msg_send![this, init] }
    }
}

/// Install the delegate (before any notification is posted) and keep it alive.
pub fn setup(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    let delegate = CenterDelegate::new();
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    *CENTER_DELEGATE.lock().unwrap() = Some(delegate);
}

/// Post `notification` through UNUserNotificationCenter, mirroring the plugin
/// behavior: buttons map through Shell.actions and the route rides in the
/// userInfo payload for click-to-open.
pub fn present(app: &AppHandle, notification: crate::notifications::Notification) {
    let index = NEXT_INDEX.fetch_add(1, Ordering::Relaxed);
    let category = category_id(index);
    let shell = app.state::<crate::Shell>();
    // setNotificationCategories replaces the whole set, so the registry keeps
    // exactly the last CATEGORY_WINDOW categories and re-registers them all.
    let kept: Vec<String> = retained_categories(index);
    let mut registered = REGISTERED.lock().unwrap();
    registered.retain(|entry| kept.contains(&entry.id));
    // Mirror the plugin's destructive window: drop button mappings that are no
    // longer registered so a late tap cannot hit a remapped category slot.
    if index >= CATEGORY_WINDOW {
        let stale = category_id(index - CATEGORY_WINDOW);
        shell
            .actions
            .lock()
            .unwrap()
            .retain(|id, _| !id.starts_with(&format!("{stale}-")));
    }
    let mut actions: Vec<(String, String)> = Vec::new();
    for (button, action) in notification.actions.iter().enumerate() {
        let id = action_id(&category, button);
        let label =
            crate::notifications::clean(action["label"].as_str().unwrap_or("Open pacer"), 40);
        shell
            .actions
            .lock()
            .unwrap()
            .insert(id.clone(), action.clone());
        actions.push((id, label));
    }
    if !actions.is_empty() {
        registered.push(Category {
            id: category.clone(),
            actions,
        });
        drop(registered);
        register_categories();
    } else {
        drop(registered);
    }
    post(&notification, &category, !notification.actions.is_empty());
}

/// Re-register every live category. `setNotificationCategories` replaces the
/// whole set, so the last [`CATEGORY_WINDOW`] categories are rebuilt from the
/// registry together.
fn register_categories() {
    let registered = REGISTERED.lock().unwrap();
    let mut category_objects: Vec<Retained<UNNotificationCategory>> = Vec::new();
    for entry in registered.iter() {
        let action_objects: Vec<Retained<UNNotificationAction>> = entry
            .actions
            .iter()
            .map(|(id, label)| {
                UNNotificationAction::actionWithIdentifier_title_options(
                    &NSString::from_str(id),
                    &NSString::from_str(label),
                    UNNotificationActionOptions::empty(),
                )
            })
            .collect();
        let action_refs: Vec<&UNNotificationAction> = action_objects.iter().map(|a| &**a).collect();
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(&entry.id),
                &NSArray::from_slice(&action_refs),
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            );
        category_objects.push(category);
    }
    let category_refs: Vec<&UNNotificationCategory> =
        category_objects.iter().map(|c| &**c).collect();
    let set = NSSet::from_slice(&category_refs);
    UNUserNotificationCenter::currentNotificationCenter().setNotificationCategories(&set);
    desktop_log!(
        "pacer notifications: registered {} categories",
        registered.len()
    );
}

fn post(notification: &crate::notifications::Notification, category: &str, has_actions: bool) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notification.title));
    content.setBody(&NSString::from_str(&notification.body));
    if !notification.route.is_empty() {
        // SAFETY: the dictionary is NSString-keyed with a plist value.
        unsafe { content.setUserInfo(&route_user_info(&notification.route)) };
    }
    if has_actions {
        content.setCategoryIdentifier(&NSString::from_str(category));
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(category),
        &content,
        None,
    );
    let completion = RcBlock::new(|error: *mut NSError| {
        if let Some(error) = unsafe { error.as_ref() } {
            desktop_log!(
                "pacer notifications: delivery error {}: {}",
                error.code(),
                error.localizedDescription()
            );
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
}

/// Map a delivered response: the default action opens the notification's
/// route; a registered button id dispatches its Shell action; anything else
/// falls back to the route so an out-of-window tap still overrides nothing bad.
fn handle_response(response: &UNNotificationResponse) {
    let Some(app) = APP_HANDLE.get() else { return };
    let action = response.actionIdentifier().to_string();
    let route = response_route(response);
    // The default-action identifier is an extern static; reading it is unsafe.
    let default_action = unsafe { UNNotificationDefaultActionIdentifier.to_string() };
    if action == default_action {
        if let Some(route) = route {
            crate::navigate(app, &route);
        }
        return;
    }
    let mapped = app
        .state::<crate::Shell>()
        .actions
        .lock()
        .unwrap()
        .get(&action)
        .cloned();
    if let Some(mapped) = mapped {
        crate::dispatch_action(app, mapped);
        return;
    }
    if let Some(route) = route {
        crate::navigate(app, &route);
    }
}

fn response_route(response: &UNNotificationResponse) -> Option<String> {
    let user_info = response.notification().request().content().userInfo();
    route_from_user_info(&user_info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSDictionary;

    #[test]
    fn category_and_action_ids_are_stable_and_unique() {
        assert_eq!(category_id(0), "pacer-attention-0");
        assert_eq!(category_id(31), "pacer-attention-31");
        assert_eq!(action_id(&category_id(3), 0), "pacer-attention-3-0");
        assert_eq!(action_id(&category_id(3), 1), "pacer-attention-3-1");
        assert_ne!(action_id(&category_id(2), 1), action_id(&category_id(3), 1));
    }

    #[test]
    fn category_window_keeps_only_the_last_32() {
        for newest in 0..=40 {
            let kept = retained_categories(newest);
            let expected = (newest + 1).min(CATEGORY_WINDOW) as usize;
            assert_eq!(kept.len(), expected, "newest={newest}");
            assert_eq!(kept.last(), Some(&category_id(newest)));
            // The set is exactly the last CATEGORY_WINDOW ids, oldest first.
            let first = newest.saturating_sub(CATEGORY_WINDOW - 1);
            assert_eq!(kept.first(), Some(&category_id(first)));
        }
    }

    #[test]
    fn route_is_read_back_from_user_info() {
        let key = NSString::from_str("route");
        let value = NSString::from_str("#/sessions/t-1");
        let info: Retained<NSDictionary> = unsafe {
            NSDictionary::dictionaryWithObject_forKey(&*value, ProtocolObject::from_ref(&*key))
        };
        assert_eq!(
            route_from_user_info(&info).as_deref(),
            Some("#/sessions/t-1")
        );
        assert_eq!(route_from_user_info(&NSDictionary::dictionary()), None);
    }
}
