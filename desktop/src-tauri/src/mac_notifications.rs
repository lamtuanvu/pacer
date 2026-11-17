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
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// How many categories, buttons and route mappings stay live. Later
/// notifications reuse a category slot; older ones are dropped so a tap on
/// still-delivered banners never resolves to an id that no longer maps.
pub const CATEGORY_WINDOW: u64 = 32;

/// Identifier of the category (and request) for the notification of ordinal
/// `index` in the launch `launch`. Delivered notifications outlive the process,
/// so the launch keeps a button on an earlier launch's banner from resolving to
/// a later launch's action.
pub fn category_id(launch: &str, index: u64) -> String {
    format!("pacer-attention-{launch}-{index}")
}

/// A per-process value that differs between launches.
fn launch_id() -> &'static str {
    static LAUNCH: OnceLock<String> = OnceLock::new();
    LAUNCH.get_or_init(|| {
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        format!("{started:x}{:x}", std::process::id())
    })
}

/// Built-in macOS sounds as `(setting id, file name)`. The file lives in
/// `/System/Library/Sounds/`; `UNNotificationSound::soundNamed` finds them there
/// (live-validated on macOS: Glass and Tink banners played their own sounds).
/// Keep the ids identical to `NOTIFICATION_SOUNDS` in `src/core/notify.ts`.
const SYSTEM_SOUNDS: &[(&str, &str)] = &[
    ("basso", "Basso.aiff"),
    ("blow", "Blow.aiff"),
    ("bottle", "Bottle.aiff"),
    ("frog", "Frog.aiff"),
    ("funk", "Funk.aiff"),
    ("glass", "Glass.aiff"),
    ("hero", "Hero.aiff"),
    ("morse", "Morse.aiff"),
    ("ping", "Ping.aiff"),
    ("pop", "Pop.aiff"),
    ("purr", "Purr.aiff"),
    ("sosumi", "Sosumi.aiff"),
    ("submarine", "Submarine.aiff"),
    ("tink", "Tink.aiff"),
];

/// Which notification sound to play, derived from the `notificationSound`
/// setting ("pacer" default, "default", "off" or a built-in macOS sound id).
/// Absent or invalid means "pacer".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SoundChoice {
    Pacer,
    Default,
    Off,
    /// A built-in macOS sound, by file name (e.g. "Glass.aiff").
    System(&'static str),
}

fn sound_choice(setting: Option<&str>) -> SoundChoice {
    match setting {
        Some("default") => SoundChoice::Default,
        Some("off") => SoundChoice::Off,
        Some(id) => SYSTEM_SOUNDS
            .iter()
            .find(|(known, _)| *known == id)
            .map_or(SoundChoice::Pacer, |(_, file)| SoundChoice::System(file)),
        None => SoundChoice::Pacer,
    }
}

impl SoundChoice {
    /// The sound file name passed to `UNNotificationSound::soundNamed`, if any.
    fn file_name(self) -> Option<&'static str> {
        match self {
            SoundChoice::Pacer => Some("pacer-drop.caf"),
            SoundChoice::System(file) => Some(file),
            SoundChoice::Default | SoundChoice::Off => None,
        }
    }

    fn sound(self) -> Option<Retained<UNNotificationSound>> {
        match self {
            SoundChoice::Default => Some(UNNotificationSound::defaultSound()),
            SoundChoice::Off => None,
            SoundChoice::Pacer | SoundChoice::System(_) => self
                .file_name()
                .map(|file| UNNotificationSound::soundNamed(&NSString::from_str(file))),
        }
    }
}

/// The notification sound to play, read from `$PACER_HOME/settings.json` at
/// every post so a settings change takes effect without a restart. The
/// `notifications` level stays a plain sibling string key.
fn sound_for_present() -> Option<Retained<UNNotificationSound>> {
    let settings = crate::client::pacer_home().join("settings.json");
    let setting = std::fs::read(&settings)
        .ok()
        .and_then(|bytes| sound_setting(&bytes));
    sound_choice(setting.as_deref()).sound()
}

/// The `notificationSound` string in `settings.json` bytes. The service
/// accepts files serde_json rejects (invalid UTF-8, lone-surrogate escapes in
/// unrelated keys), so when strict parsing fails this falls back to a scan for
/// the top-level key, whose valid values are plain ASCII.
fn sound_setting(bytes: &[u8]) -> Option<String> {
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) {
        return value.get("notificationSound")?.as_str().map(str::to_owned);
    }
    let text = String::from_utf8_lossy(bytes);
    let mut found = None;
    let mut rest = text.as_ref();
    // The last occurrence wins, as with duplicate keys in JSON.parse.
    while let Some(at) = rest.find("\"notificationSound\"") {
        rest = &rest[at + "\"notificationSound\"".len()..];
        let value = rest.trim_start().strip_prefix(':').map(str::trim_start);
        if let Some(value) = value.and_then(|v| v.strip_prefix('"')) {
            if let Some(end) = value.find('"') {
                found = Some(value[..end].to_owned());
            }
        }
    }
    found
}

/// The button-id prefix that leaves the window when notification `index` is
/// posted. The trailing dash keeps index 1 from matching index 10.
pub fn stale_prefix(launch: &str, index: u64) -> Option<String> {
    let stale = index.checked_sub(CATEGORY_WINDOW)?;
    Some(format!("{}-", category_id(launch, stale)))
}

/// UNUserNotificationCenter raises an exception for an unbundled dev executable.
fn bundled() -> bool {
    objc2_foundation::NSBundle::mainBundle()
        .bundleIdentifier()
        .is_some()
}

/// Identifier of the `button`th action inside `category`; this is the id a
/// button tap delivers to the notification center delegate.
pub fn action_id(category: &str, button: usize) -> String {
    format!("{category}-{button}")
}

/// The categories that must stay registered once a notification with this
/// newest index exists: the last [`CATEGORY_WINDOW`], oldest first.
pub fn retained_categories(launch: &str, newest: u64) -> Vec<String> {
    let from = newest.saturating_sub(CATEGORY_WINDOW - 1);
    (from..=newest)
        .map(|index| category_id(launch, index))
        .collect()
}

/// The route `post` stored in the notification's userInfo.
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

// Handles banners while pacer is frontmost and taps on posted banners. The
// handlers it calls only use the AppHandle, which any thread may use.
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    struct CenterDelegate;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for CenterDelegate {}

    // SAFETY: UNUserNotificationCenterDelegate has no safety requirements; the
    // completion handlers below are always called exactly once.
    unsafe impl UNUserNotificationCenterDelegate for CenterDelegate {
        /// Present the banner and the list row even while pacer is the frontmost
        /// app (the default would suppress banners). Include `Sound` so the
        /// sound set on the content (if any) plays while pacer is focused.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound;
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
    if !bundled() {
        desktop_log!("pacer notifications: presenting requires an app bundle");
        return;
    }
    let _ = APP_HANDLE.set(app.clone());
    let delegate = CenterDelegate::new();
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    *CENTER_DELEGATE.lock().unwrap() = Some(delegate);
}

/// Post `notification` through UNUserNotificationCenter: buttons map through
/// Shell.actions and the route rides in userInfo for click-to-open.
pub fn present(app: &AppHandle, notification: crate::notifications::Notification) {
    if !bundled() {
        return;
    }
    let launch = launch_id();
    // Read before taking the registry lock: it is file I/O.
    let sound = sound_for_present();
    // Allocating under the registry lock keeps concurrent posts from dropping a
    // newer category while registering an older one.
    let mut registered = REGISTERED.lock().unwrap();
    let index = NEXT_INDEX.fetch_add(1, Ordering::Relaxed);
    let category = category_id(launch, index);
    let shell = app.state::<crate::Shell>();
    if let Some(stale) = stale_prefix(launch, index) {
        shell
            .actions
            .lock()
            .unwrap()
            .retain(|id, _| !id.starts_with(&stale));
    }
    let client_id = notification.client_id.clone();
    let notify_key = notification.key.clone();
    let request = request(&notification, &category, sound);
    if notification.actions.is_empty() {
        drop(registered);
        add(&request, client_id, notify_key);
        return;
    }
    let mut actions = Vec::new();
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
    let kept = retained_categories(launch, index);
    registered.retain(|entry| kept.contains(&entry.id));
    registered.push(Category {
        id: category,
        actions,
    });
    let center = UNUserNotificationCenter::currentNotificationCenter();
    // setNotificationCategories replaces the whole set and applies asynchronously;
    // reading the set back orders the post after it, so the banner gets its buttons.
    center.setNotificationCategories(&categories(&registered));
    drop(registered);
    let ack_client = client_id.clone();
    let ack_key = notify_key.clone();
    let after = RcBlock::new(move |_: NonNull<NSSet<UNNotificationCategory>>| add(&request, ack_client.clone(), ack_key.clone()));
    center.getNotificationCategoriesWithCompletionHandler(&after);
}

fn categories(registered: &[Category]) -> Retained<NSSet<UNNotificationCategory>> {
    let objects: Vec<Retained<UNNotificationCategory>> = registered
        .iter()
        .map(|entry| {
            let actions: Vec<Retained<UNNotificationAction>> = entry
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
            let actions: Vec<&UNNotificationAction> = actions.iter().map(|a| &**a).collect();
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(&entry.id),
                &NSArray::from_slice(&actions),
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            )
        })
        .collect();
    let objects: Vec<&UNNotificationCategory> = objects.iter().map(|c| &**c).collect();
    NSSet::from_slice(&objects)
}

fn request(
    notification: &crate::notifications::Notification,
    category: &str,
    sound: Option<Retained<UNNotificationSound>>,
) -> Retained<UNNotificationRequest> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notification.title));
    content.setBody(&NSString::from_str(&notification.body));
    if let Some(sound) = sound {
        content.setSound(Some(&sound));
    }
    if !notification.route.is_empty() {
        // SAFETY: the dictionary is NSString-keyed with a plist value.
        unsafe { content.setUserInfo(&route_user_info(&notification.route)) };
    }
    if !notification.actions.is_empty() {
        content.setCategoryIdentifier(&NSString::from_str(category));
    }
    // The category id is unique per launch and notification, so a post never
    // replaces an earlier delivered notification.
    UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(category),
        &content,
        None,
    )
}

/// Build the `notifications.ack` payload from the addNotificationRequest
/// completion outcome. Sent exactly once; a failed ack is logged, never retried.
fn ack_params(
    client_id: String,
    key: String,
    delivered: bool,
    error: Option<String>,
) -> serde_json::Value {
    // Omit `error` entirely when there is none: the service schema rejects `error: null`.
    let mut value = serde_json::Map::new();
    value.insert("client_id".into(), client_id.into());
    value.insert("key".into(), key.into());
    value.insert("delivered".into(), delivered.into());
    if let Some(error) = error {
        value.insert("error".into(), error.into());
    }
    serde_json::Value::Object(value)
}

fn add(request: &UNNotificationRequest, client_id: Option<String>, key: Option<String>) {
    let completion = RcBlock::new(move |error: *mut NSError| {
        let error_ref = unsafe { error.as_ref() };
        if let Some(error) = error_ref {
            desktop_log!(
                "pacer notifications: delivery error {}: {}",
                error.code(),
                error.localizedDescription()
            );
        }
        let delivered = error_ref.is_none();
        let error_message = error_ref.map(|e| e.localizedDescription().to_string());
        if let (Some(client_id), Some(key)) = (client_id.clone(), key.clone()) {
            let params = ack_params(client_id.clone(), key, delivered, error_message);
            let app = APP_HANDLE.get().cloned();
            tauri::async_runtime::spawn(async move {
                let Some(app) = app else { return; };
                let session = app.state::<crate::Shell>().session.lock().unwrap().clone();
                let Some(session) = session else {
                    desktop_log!("pacer notifications: no live session for ack");
                    return;
                };
                if let Err(err) = session.op("notifications.ack", &params).await {
                    desktop_log!("pacer notifications: ack failed: {err}");
                }
            });
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(request, Some(&completion));
}

/// Map a delivered response: the default action opens the notification's
/// route; a registered button id dispatches its Shell action; a button whose
/// mapping aged out of the window opens the route instead.
fn handle_response(response: &UNNotificationResponse) {
    let Some(app) = APP_HANDLE.get() else { return };
    let action = response.actionIdentifier().to_string();
    // The default-action identifier is an extern static; reading it is unsafe.
    let default = action == unsafe { UNNotificationDefaultActionIdentifier.to_string() };
    let mapped = (!default)
        .then(|| {
            let actions = app.state::<crate::Shell>();
            let found = actions.actions.lock().unwrap().get(&action).cloned();
            found
        })
        .flatten();
    match respond(default, mapped, response_route(response)) {
        Response::Dispatch(action) => crate::dispatch_action(app, action),
        Response::Navigate(route) => crate::navigate(app, &route),
        Response::Ignore => {}
    }
}

#[derive(Debug, PartialEq)]
pub enum Response {
    Dispatch(serde_json::Value),
    Navigate(String),
    Ignore,
}

/// A click opens the route; a mapped button runs its action; a button whose
/// mapping aged out of the window falls back to the route.
pub fn respond(
    default: bool,
    mapped: Option<serde_json::Value>,
    route: Option<String>,
) -> Response {
    match (default, mapped, route) {
        (false, Some(action), _) => Response::Dispatch(action),
        (_, _, Some(route)) => Response::Navigate(route),
        _ => Response::Ignore,
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
    fn sound_setting_reads_strict_and_lenient_settings() {
        assert_eq!(
            sound_setting(br#"{"notifications":"all","notificationSound":"off"}"#).as_deref(),
            Some("off")
        );
        assert_eq!(sound_setting(br#"{"notifications":"all"}"#), None);
        assert_eq!(sound_setting(br#"{"notificationSound":3}"#), None);
        // serde_json rejects a lone surrogate and invalid UTF-8; the service does not.
        assert_eq!(
            sound_setting(br#"{"0":"\ud83d","notificationSound":"off"}"#).as_deref(),
            Some("off")
        );
        assert_eq!(
            sound_setting(b"{\"x\":\"\xff\",\"notificationSound\" : \"default\"}").as_deref(),
            Some("default")
        );
        assert_eq!(
            sound_setting(br#"{"notificationSound":"glass"}"#).as_deref(),
            Some("glass")
        );
        assert_eq!(
            sound_setting(b"{\"x\":\"\xff\",\"notificationSound\":\"tink\"}").as_deref(),
            Some("tink")
        );
        assert_eq!(sound_setting(b"not json"), None);
        assert_eq!(
            sound_choice(sound_setting(br#"{"0":"\ud83d","notificationSound":"off"}"#).as_deref()),
            SoundChoice::Off
        );
    }

    #[test]
    fn category_and_action_ids_are_stable_and_unique() {
        assert_eq!(category_id("a1", 0), "pacer-attention-a1-0");
        assert_eq!(
            action_id(&category_id("a1", 3), 1),
            "pacer-attention-a1-3-1"
        );
        assert_ne!(
            action_id(&category_id("a1", 2), 1),
            action_id(&category_id("a1", 3), 1)
        );
        // A later launch never reuses an earlier launch's ids.
        assert_ne!(category_id("a1", 3), category_id("b2", 3));
    }

    #[test]
    fn category_window_keeps_only_the_last_32() {
        for newest in 0..=40 {
            let kept = retained_categories("a1", newest);
            let expected = (newest + 1).min(CATEGORY_WINDOW) as usize;
            assert_eq!(kept.len(), expected, "newest={newest}");
            assert_eq!(kept.last(), Some(&category_id("a1", newest)));
            // The set is exactly the last CATEGORY_WINDOW ids, oldest first.
            let first = newest.saturating_sub(CATEGORY_WINDOW - 1);
            assert_eq!(kept.first(), Some(&category_id("a1", first)));
        }
    }

    #[test]
    fn stale_prefix_drops_exactly_the_mapping_leaving_the_window() {
        assert_eq!(stale_prefix("a1", CATEGORY_WINDOW - 1), None);
        let stale = stale_prefix("a1", CATEGORY_WINDOW + 1).unwrap();
        assert!(action_id(&category_id("a1", 1), 0).starts_with(&stale));
        assert!(!action_id(&category_id("a1", 10), 0).starts_with(&stale));
        assert!(!action_id(&category_id("b2", 1), 0).starts_with(&stale));
    }

    #[test]
    fn launch_id_is_stable_within_a_launch() {
        assert!(!launch_id().is_empty());
        assert_eq!(launch_id(), launch_id());
    }

    #[test]
    fn responses_open_the_route_or_run_the_mapped_button() {
        let retry = serde_json::json!({"op": "task.retry"});
        let route = || Some("#/tasks/t-1".to_string());
        assert_eq!(
            respond(true, None, route()),
            Response::Navigate("#/tasks/t-1".into())
        );
        assert_eq!(
            respond(false, Some(retry.clone()), route()),
            Response::Dispatch(retry)
        );
        // A click on the banner itself opens the route even if a mapping exists.
        assert_eq!(
            respond(true, Some(serde_json::json!({"op": "task.retry"})), route()),
            Response::Navigate("#/tasks/t-1".into())
        );
        // An aged-out button opens the notification's route instead.
        assert_eq!(
            respond(false, None, route()),
            Response::Navigate("#/tasks/t-1".into())
        );
        assert_eq!(respond(false, None, None), Response::Ignore);
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

    #[test]
    fn ack_payload_carries_the_id_key_delivery_and_optional_error() {
        // A successful delivery omits `error` entirely (the schema rejects `error: null`).
        assert_eq!(
            ack_params("client-a".into(), "test:abc".into(), true, None),
            serde_json::json!({"client_id":"client-a","key":"test:abc","delivered":true})
        );
        assert_eq!(
            ack_params("client-b".into(), "test:def".into(), false, Some("banner rejected".into())),
            serde_json::json!({"client_id":"client-b","key":"test:def","delivered":false,"error":"banner rejected"})
        );
    }

    #[test]
    fn sound_choice_falls_back_to_pacer_and_resolves_each_option() {
        // Absent or invalid values mean the bundled pacer sound.
        assert_eq!(sound_choice(None), SoundChoice::Pacer);
        assert_eq!(sound_choice(Some("pacer")), SoundChoice::Pacer);
        assert_eq!(sound_choice(Some("squeak")), SoundChoice::Pacer);
        assert_eq!(sound_choice(Some("")), SoundChoice::Pacer);
        assert_eq!(sound_choice(Some("default")), SoundChoice::Default);
        assert_eq!(sound_choice(Some("off")), SoundChoice::Off);
        // Ids are lowercase; the file name is not an id.
        assert_eq!(sound_choice(Some("Glass")), SoundChoice::Pacer);
        assert_eq!(sound_choice(Some("Glass.aiff")), SoundChoice::Pacer);
    }

    #[test]
    fn sound_ids_map_to_their_file_names() {
        assert_eq!(sound_choice(None).file_name(), Some("pacer-drop.caf"));
        assert_eq!(sound_choice(Some("default")).file_name(), None);
        assert_eq!(sound_choice(Some("off")).file_name(), None);
        assert_eq!(sound_choice(Some("glass")).file_name(), Some("Glass.aiff"));
        assert_eq!(
            sound_choice(Some("submarine")).file_name(),
            Some("Submarine.aiff")
        );
        let ids: Vec<_> = SYSTEM_SOUNDS.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            ids,
            [
                "basso",
                "blow",
                "bottle",
                "frog",
                "funk",
                "glass",
                "hero",
                "morse",
                "ping",
                "pop",
                "purr",
                "sosumi",
                "submarine",
                "tink"
            ]
        );
        for (id, file) in SYSTEM_SOUNDS {
            let mut chars = id.chars();
            let capitalized: String = chars
                .next()
                .map(|c| c.to_ascii_uppercase())
                .into_iter()
                .chain(chars)
                .collect();
            assert_eq!(*file, format!("{capitalized}.aiff"));
            assert_eq!(sound_choice(Some(id)), SoundChoice::System(file));
        }
    }
}
