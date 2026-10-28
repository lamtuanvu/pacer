#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
macro_rules! desktop_log {
    ($($arg:tt)*) => { crate::logging::write(format_args!($($arg)*)) };
}
mod client_control;
mod actions;
mod approvals;
mod capture;
mod client;
mod link;
mod logging;
mod logic;
mod notifications;
mod open_file;
mod permission_setup;
mod profile;
mod tray_model;
mod update_journal;

use reqwest::Url;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
#[cfg(target_os = "macos")]
use tauri_plugin_notification::{Action, ActionType};
use tauri_plugin_positioner::{Position, WindowExt};
use tray_model::TrayModel;

#[tauri::command]
async fn native_validation_setup(window: WebviewWindow, app: AppHandle) -> Result<permission_setup::SetupResult, String> {
    authorized(&window, &app)?;
    let result = permission_setup::request().await?;
    authorized(&window, &app)?;
    Ok(result)
}

struct Shell {
    #[cfg(feature = "ota-fixture")]
    fixture_tray_auth: Mutex<Option<Url>>,
    native: Mutex<Option<Arc<pacer_desktop::ota::control::NativeConnection>>>,
    native_update_error: Mutex<Option<pacer_desktop::ota::OtaError>>,
    navigation: Mutex<pacer_desktop::ota::control::NavigationState>,
    adoption: Mutex<Option<pacer_desktop::ota::control::AdoptionReconnectPlan>>,
    maintenance: AtomicBool,
    /// Whether the tray icon currently carries the red attention dot.
    tray_alert: AtomicBool,
    #[cfg(target_os = "macos")]
    relaunch: Mutex<Option<std::process::Command>>,
    startup: Mutex<logic::Startup>,
    origin: Mutex<Option<String>>,
    route: Mutex<String>,
    recovery: Mutex<String>,
    granted: Mutex<Vec<String>>,
    waiting: Mutex<Option<String>>,
    diagnosis: Mutex<Option<logic::Diagnosis>>,
    retry: AtomicBool,
    relink_dismissed: AtomicBool,
    shell_action: Mutex<Option<logic::ShellAction>>,
    old_service_ack: Mutex<Option<String>>,
    pending_service_key: Mutex<Option<String>>,
    onboarding_page: Mutex<Option<logic::Onboarding>>,
    session: Mutex<Option<client::Session>>,
    expired: tokio::sync::Notify,
    wake: tokio::sync::Notify,
    actions: Mutex<std::collections::HashMap<String, Value>>,
}
impl Default for Shell {
    fn default() -> Self {
        Self {
            #[cfg(feature = "ota-fixture")]
            fixture_tray_auth: Mutex::new(None),
            native: Mutex::new(None),
            native_update_error: Mutex::new(None),
            navigation: Mutex::new(Default::default()),
            adoption: Mutex::new(None),
            maintenance: AtomicBool::new(false),
            tray_alert: AtomicBool::new(false),
            #[cfg(target_os = "macos")]
            relaunch: Mutex::new(None),
            startup: Mutex::new(logic::Startup::default()),
            origin: Mutex::new(None),
            route: Mutex::new("#/".into()),
            recovery: Mutex::new(String::new()),
            granted: Mutex::new(Vec::new()),
            waiting: Mutex::new(None),
            diagnosis: Mutex::new(None),
            retry: AtomicBool::new(false),
            relink_dismissed: AtomicBool::new(false),
            shell_action: Mutex::new(None),
            old_service_ack: Mutex::new(None),
            pending_service_key: Mutex::new(None),
            onboarding_page: Mutex::new(None),
            session: Mutex::new(None),
            expired: tokio::sync::Notify::new(),
            wake: tokio::sync::Notify::new(),
            actions: Mutex::new(std::collections::HashMap::new()),
        }
    }
}
/// Popover width from the TrayPopover board.
const TRAY_WIDTH: f64 = 340.;

fn authorized(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    let url = window.url().map_err(|_| "Unknown caller")?;
    if !logic::command_authorized(
        window.label(),
        "main",
        &url,
        app.state::<Shell>().origin.lock().unwrap().as_deref(),
    ) {
        return Err("IPC is restricted to the active local service".into());
    }
    Ok(())
}
fn authorized_tray(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    let url = window.url().map_err(|_| "Unknown caller")?;
    if !logic::command_authorized(
        window.label(),
        "tray",
        &url,
        app.state::<Shell>().origin.lock().unwrap().as_deref(),
    ) {
        return Err("IPC is restricted to the active local tray".into());
    }
    Ok(())
}
#[tauri::command]
fn session_expired(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    match window.label() {
        "main" => authorized(&window, &app)?,
        "tray" => authorized_tray(&window, &app)?,
        _ => return Err("Unknown caller".into()),
    }
    app.state::<Shell>().expired.notify_one();
    Ok(())
}
#[tauri::command]
fn desktop_version(window: WebviewWindow, app: AppHandle) -> Result<String, String> {
    authorized(&window, &app)?;
    Ok(app.package_info().version.to_string())
}
#[tauri::command]
fn host_file_actions(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    authorized(&window, &app)?;
    Ok(open_file::supported(std::env::consts::OS))
}
/// Hand a session file to the user's editor or file manager (ADR 0011). The page
/// names only a session reference; the service resolves it by the bounded read's
/// rules and the shell re-checks the file before launching an argument vector.
#[tauri::command]
async fn open_session_file(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    attempt: u64,
    reference: String,
    action: String,
) -> Result<(), String> {
    authorized(&window, &app)?;
    let action = open_file::Action::parse(&action).ok_or("Unknown file action")?;
    let session = app
        .state::<Shell>()
        .session
        .lock()
        .unwrap()
        .clone()
        .ok_or("The local service is not connected")?;
    let resolution = session
        .op(
            "session.file.resolve",
            &serde_json::json!({"id": id, "attempt": attempt, "reference": reference}),
        )
        .await?;
    // The active service can change while the request is outstanding.
    authorized(&window, &app)?;
    let resolved = open_file::parse_resolution(&resolution)?;
    let editor = match action {
        open_file::Action::Open => open_file::load_editor(&client::pacer_home())?,
        open_file::Action::Reveal => None,
    };
    let mode = open_file::verify(&resolved)?;
    let argv = open_file::argv(action, &resolved, mode, editor.as_deref(), std::env::consts::OS)?;
    open_file::spawn(argv)
}
#[tauri::command]
fn rounded_window_supported(window: WebviewWindow, app: AppHandle) -> Result<bool, String> {
    authorized(&window, &app)?;
    Ok(true)
}
#[tauri::command]
fn native_titlebar_supported(window: WebviewWindow, app: AppHandle) -> Result<bool, String> {
    authorized(&window, &app)?;
    Ok(cfg!(target_os = "macos"))
}
#[tauri::command]
fn desktop_update_connection(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    authorized(&window, &app)?;
    let shell = app.state::<Shell>();
    let alive = shell.native.lock().unwrap().as_ref().is_some_and(|native| native.alive());
    let error = *shell.native_update_error.lock().unwrap();
    Ok(logic::desktop_update_connection(pacer_desktop::ota::trust::ReleaseTrust::configured().is_some(), alive, error))
}
#[tauri::command]
fn session_ready(
    window: WebviewWindow,
    app: AppHandle,
    nonce: Option<String>,
) -> Result<(), String> {
    authorized(&window, &app)?;
    let shell = app.state::<Shell>();
    let native = shell.native.lock().unwrap().clone();
    if let Some(native) = native {
        let origin = shell
            .origin
            .lock()
            .unwrap()
            .clone()
            .ok_or("Native service origin missing")?;
        let desktop = pacer_desktop::ota::native::process_details(std::process::id())
            .map_err(|_| "Native desktop identity missing")?
            .ok_or("Native desktop identity missing")?
            .identity;
        let proof = shell
            .navigation
            .lock()
            .unwrap()
            .document_ready(
                &origin,
                nonce
                    .as_deref()
                    .ok_or("Native document challenge missing")?,
                &desktop,
                &native.service,
                &native.session.session_id,
                env!("CARGO_PKG_VERSION"),
                &native.session.service_version,
                3,
                true,
            )
            .map_err(|_| "Native document acknowledgement rejected")?;
        native
            .document_ready(proof)
            .map_err(|_| "Native service acknowledgement unavailable")?;
    } else if shell.maintenance.load(Ordering::SeqCst) {
        return Err("Native maintenance sign-in is pending".into());
    }
    app.state::<Shell>().startup.lock().unwrap().ready();
    desktop_log!("pacer lifecycle: desktop sign-in complete");
    // Clear a sign-in dot, but keep an update failure that the current snapshot reports.
    set_error_dot(&app, app.state::<Shell>().tray_alert.load(Ordering::SeqCst));
    Ok(())
}
// Runs in the trusted service document, including script-free error pages. Also
// recognizes pages from older services which do not yet carry the marker.
const CHECK_SESSION_PAGE: &str = r#"if (document.querySelector('[data-pacer-session-ended]') || (!document.getElementById('app') && /Session ended|This link has expired/.test(document.body.textContent))) { window.__TAURI__?.core.invoke('session_expired').catch(() => {}); } else if (document.getElementById('app')) { window.__TAURI__?.core.invoke('session_ready').catch(() => {}); }"#;

fn check_main_document(window: &WebviewWindow, url: &Url) {
    let app = window.app_handle();
    let shell = app.state::<Shell>();
    let origin = shell.origin.lock().unwrap().clone();
    if let Some(origin) = origin {
        if logic::command_authorized("main", "main", url, Some(&origin))
            && matches!(url.path(), "/app" | "/app/")
            && shell.native.lock().unwrap().is_some()
        {
            if let Ok(nonce) = shell.navigation.lock().unwrap().begin_navigation(&origin) {
                let args = serde_json::json!({"nonce":nonce});
                let script = CHECK_SESSION_PAGE.replace(
                    "invoke('session_ready')",
                    &format!("invoke('session_ready', {args})"),
                );
                let _ = window.eval(&script);
                return;
            }
        }
    }
    let _ = window.eval(CHECK_SESSION_PAGE);
}

fn show_service_version_notice(window: &WebviewWindow, raw_version: &str) {
    let label = if logic::service_release(env!("CARGO_PKG_VERSION"), Some(raw_version))
        == logic::ServiceRelease::Older
    {
        format!("Service {} is older than this app · New controls are unavailable", logic::display_service_release(Some(raw_version)))
    } else {
        "Service version unverified · New controls may be unavailable".into()
    };
    let label = serde_json::to_string(&label).unwrap();
    let script = format!(r#"(() => {{
        const root = document.getElementById('app');
        if (!root) return;
        const ensure = () => {{
            const work = root.querySelector('.pc-work');
            const liveRegion = work?.querySelector('.pc-live-region');
            if (!liveRegion) return;
            let notice = document.getElementById('pacer-native-service-version');
            if (!notice) {{
                notice = document.createElement('div');
                notice.id = 'pacer-native-service-version';
                notice.className = 'connection-bar';
                notice.setAttribute('role', 'status');
                notice.style.cssText = 'position:sticky;top:0;z-index:var(--layer-sticky)';
            }}
            const topBar = work.querySelector(':scope > .pc-topbar');
            notice.style.top = topBar ? `${{topBar.getBoundingClientRect().height}}px` : '0';
            if (notice.textContent !== {label}) notice.textContent = {label};
            if (notice.parentElement !== work || notice.nextElementSibling !== liveRegion) work.insertBefore(notice, liveRegion);
        }};
        ensure();
        new MutationObserver(ensure).observe(root, {{childList:true,subtree:true}});
    }})()"#);
    let _ = window.eval(&script);
}

#[tauri::command]
fn tray_resize(window: WebviewWindow, app: AppHandle, height: f64) -> Result<(), String> {
    authorized_tray(&window, &app)?;
    let height = logic::tray_height(height).ok_or("Invalid height")?;
    window
        .set_size(tauri::LogicalSize::new(TRAY_WIDTH, height))
        .map_err(|e| e.to_string())?;
    let positioned = position_tray(&window);
    if window.is_visible().map_err(|e| e.to_string())? {
        positioned.map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn tray_open(window: WebviewWindow, app: AppHandle, route: String) -> Result<(), String> {
    authorized_tray(&window, &app)?;
    let route = logic::route(&route).ok_or("Invalid route")?;
    navigate(&app, &route);
    window.hide().map_err(|e| e.to_string())
}
#[tauri::command]
fn tray_hide(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized_tray(&window, &app)?;
    window.hide().map_err(|e| e.to_string())
}
#[tauri::command]
fn app_quit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized_tray(&window, &app)?;
    app.exit(0);
    Ok(())
}
fn create_tray_window(app: &AppHandle, origin: &str) -> Result<(), String> {
    if app.get_webview_window("tray").is_some() {
        return Ok(());
    }
    #[cfg(feature = "ota-fixture")]
    let initial = app
        .state::<Shell>()
        .fixture_tray_auth
        .lock()
        .unwrap()
        .take()
        .filter(|url| logic::fixture_tray_auth(url, origin))
        .ok_or("Isolated tray sign-in unavailable")?;
    #[cfg(not(feature = "ota-fixture"))]
    let initial = Url::parse(&format!("{origin}/app/tray.html")).expect("validated service origin");
    let nav = app.clone();
    let window = tauri::WebviewWindowBuilder::new(app, "tray", WebviewUrl::External(initial))
        .incognito(cfg!(feature = "ota-fixture"))
        .title("pacer")
        .inner_size(TRAY_WIDTH, 120.)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                #[cfg(feature = "ota-fixture")]
                if payload.url().path() == "/app/" {
                    let origin = window
                        .app_handle()
                        .state::<Shell>()
                        .origin
                        .lock()
                        .unwrap()
                        .clone();
                    if origin
                        .as_deref()
                        .is_some_and(|origin| logic::fixture_tray_navigation(payload.url(), origin))
                    {
                        let _ = window.eval("location.replace('/app/tray.html')");
                    }
                    return;
                }
                let _ = window.eval(CHECK_SESSION_PAGE);
            }
        })
        .on_navigation(move |url| {
            let origin = nav.state::<Shell>().origin.lock().unwrap().clone();
            #[cfg(feature = "ota-fixture")]
            {
                origin
                    .as_deref()
                    .is_some_and(|origin| logic::fixture_tray_navigation(url, origin))
            }
            #[cfg(not(feature = "ota-fixture"))]
            {
                logic::command_authorized("tray", "tray", url, origin.as_deref())
                    && url.path() == "/app/tray.html"
            }
        })
        .build()
        .map_err(|error| error.to_string())?;
    let blur = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let _ = blur.hide();
        }
    });
    Ok(())
}
fn position_tray(window: &WebviewWindow) -> tauri::Result<()> {
    // Linux appindicators do not expose tray coordinates. Other platforms may
    // also lack a rectangle before their first tray event.
    #[cfg(not(target_os = "linux"))]
    if window.move_window(Position::TrayBottomCenter).is_ok() {
        return Ok(());
    }
    window.move_window(Position::TopCenter)
}
fn toggle_tray(app: &AppHandle) {
    if app.state::<Shell>().session.lock().unwrap().is_none() {
        if let Err(error) = create_recovery_tray(app) {
            desktop_log!("Unable to show pacer status: {error}");
        }
    }
    if let Some(window) = app.get_webview_window("tray") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = position_tray(&window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        show(app);
    }
}
#[allow(non_snake_case)]
#[tauri::command]
fn setLaunchAtLogin(window: WebviewWindow, app: AppHandle, enabled: bool) -> Result<(), String> {
    authorized(&window, &app)?;
    launch_at_login(&app, enabled)
}
#[cfg(feature = "ota-fixture")]
fn launch_at_login(_app: &AppHandle, _enabled: bool) -> Result<(), String> {
    Err("Launch at login is unavailable in isolated fixtures".into())
}
#[cfg(not(feature = "ota-fixture"))]
fn launch_at_login(app: &AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let native = approvals::launch_at_login(enabled);
    #[cfg(not(target_os = "macos"))]
    let native: Option<Result<(), String>> = None;
    if let Some(result) = native {
        result?;
    } else {
        let manager = app.autolaunch();
        (if enabled {
            manager.enable()
        } else {
            manager.disable()
        })
        .map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("pacer") {
        let _ = tray.set_tooltip(Some("pacer"));
    }
    Ok(())
}
#[allow(non_snake_case)]
#[tauri::command]
fn setTheme(window: WebviewWindow, app: AppHandle, theme: String) -> Result<(), String> {
    authorized(&window, &app)?;
    apply_theme(&window, &theme)?;
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    std::fs::write(path.join("theme.json"), serde_json::to_vec(&theme).unwrap())
        .map_err(|e| e.to_string())
}
fn apply_theme(window: &WebviewWindow, theme: &str) -> Result<(), String> {
    let theme = match theme {
        "system" => None,
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => return Err("Theme must be system, light or dark".into()),
    };
    window.set_theme(theme).map_err(|e| e.to_string())
}
#[allow(non_snake_case)]
#[tauri::command]
fn windowMinimize(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized(&window, &app)?;
    window.minimize().map_err(|e| e.to_string())
}
#[allow(non_snake_case)]
#[tauri::command]
fn windowToggleMaximize(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized(&window, &app)?;
    match window.is_maximized() {
        Ok(true) => window.unmaximize().map_err(|e| e.to_string()),
        _ => window.maximize().map_err(|e| e.to_string()),
    }
}
#[allow(non_snake_case)]
#[tauri::command]
fn windowClose(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized(&window, &app)?;
    // For main window, we hide instead of closing (matches CloseRequested behavior)
    if window.label() == "main" {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.close().map_err(|e| e.to_string())
    }
}
#[allow(non_snake_case)]
#[tauri::command]
fn notifyRoute(window: WebviewWindow, app: AppHandle, route: String) -> Result<(), String> {
    authorized(&window, &app)?;
    *app.state::<Shell>().route.lock().unwrap() = logic::route(&route).ok_or("Invalid route")?;
    Ok(())
}
fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn navigate(app: &AppHandle, raw: &str) {
    if let Some(route) = logic::route(raw) {
        let state = app.state::<Shell>();
        *state.route.lock().unwrap() = route.clone();
        let origin = state.origin.lock().unwrap().clone();
        if let Some(origin) = origin {
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(url) = Url::parse(&format!("{origin}/app/{route}")) {
                    let _ = w.navigate(url);
                }
            }
        }
        show(app);
    }
}
fn shell_url(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}
fn shell_action(app: &AppHandle, url: &Url, current: Option<&Url>) -> bool {
    if logic::dismiss_relink(url, current)
        && app.state::<Shell>().diagnosis.lock().unwrap().as_ref()
            .is_some_and(|d| d.page == "relink")
    {
        app.state::<Shell>().relink_dismissed.store(true, Ordering::SeqCst);
        app.state::<Shell>().startup.lock().unwrap().ready();
        return false; // Allow the requested local starting page to load.
    }
    if logic::onboarding_back(url, current) {
        *app.state::<Shell>().onboarding_page.lock().unwrap() = Some(logic::Onboarding::Welcome);
        return true;
    }
    let bundled = logic::bundled_shell(current);
    if let Some(action) = logic::shell_action_url(url) {
        if bundled && (action != logic::ShellAction::ContinueOldService
            || app.state::<Shell>().diagnosis.lock().unwrap().as_ref()
                .is_some_and(|d| matches!(d.page, "outdatedService" | "unverifiedService"))) {
            // The lifecycle loop is the sole owner of setup and service mutations.
            app.state::<Shell>()
                .shell_action
                .lock()
                .unwrap()
                .get_or_insert(action);
            app.state::<Shell>().wake.notify_one();
        }
        return true;
    }
    if url.as_str()
        != "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
    {
        return false;
    }
    let bundled = current
        .is_some_and(|current| shell_url(current) && matches!(current.path(), "/" | "/index.html"));
    if !bundled {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn(async {
            let result = tokio::process::Command::new("/usr/bin/open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
                .status().await;
            desktop_log!("pacer lifecycle: open Files and Folders settings: {result:?}");
        });
    }
    true
}
fn diagnostic_recovery(app: &AppHandle, diagnosis: &logic::Diagnosis) {
    let stuck = app
        .state::<Shell>()
        .startup
        .lock()
        .unwrap()
        .diagnosis(std::time::Instant::now());
    let diagnosis = if diagnosis.page == "starting" {
        stuck.as_ref().unwrap_or(diagnosis)
    } else {
        diagnosis
    };
    *app.state::<Shell>().diagnosis.lock().unwrap() = Some(diagnosis.clone());
    recovery(app, diagnosis.page);
}
fn render_diagnosis(app: &AppHandle) {
    let detail = app.state::<Shell>().diagnosis.lock().unwrap().clone();
    if let Some(detail) = detail {
        if let Ok(json) = serde_json::to_string(&detail) {
            for label in ["main", "tray"] {
                if let Some(window) = app.get_webview_window(label) {
                    if window.url().is_ok_and(|url| shell_url(&url)) {
                        let _ = window.eval(format!("window.renderShell?.({json})"));
                    }
                }
            }
        }
    }
}
fn recovery(app: &AppHandle, state: &str) {
    let shell = app.state::<Shell>();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("pacer");
    }
    let had_origin = shell.origin.lock().unwrap().take().is_some();
    if had_origin {
        if let Some(window) = app.get_webview_window("tray") {
            let _ = window.destroy();
        }
    }
    *shell.session.lock().unwrap() = None;
    let changed = {
        let mut current = shell.recovery.lock().unwrap();
        let changed = *current != state;
        *current = state.into();
        changed
    };
    {
        let mut detail = shell.diagnosis.lock().unwrap();
        if detail.as_ref().is_none_or(|d| d.page != state) {
            let value = logic::diagnosis(
                match state {
                    "oldService" => "oldService",
                    "outdatedService" => "outdatedService",
                    "unverifiedService" => "unverifiedService",
                    "oldApp" => "oldApp",
                    "protocol" => "protocol",
                    "permission" => "permission",
                    "install" => "install",
                    "welcome" => "welcome",
                    "consent" => "consent",
                    "existing" => "existing",
                    "incomplete" => "incomplete",
                    "relink" => "relink",
                    "foreign" => "foreign",
                    "stuck" => "stuck",
                    "installing" => "installing",
                    "rollingBack" => "rollingBack",
                    "restored" => "restored",
                    "recoveryFailed" => "recoveryFailed",
                    _ => "starting",
                },
                None,
            );
            *detail = Some(value);
        }
    }
    if changed {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(url) = Url::parse(&format!("tauri://localhost/index.html?state={state}")) {
                let _ = window.navigate(url);
            }
        }
    }
    render_diagnosis(app);
    let title = match state {
        "stuck" => "pacer could not finish signing in",
        "permission" => "macOS needs your permission",
        "oldApp" => "Update the pacer app",
        "oldService" => "Update pacer",
        "outdatedService" => "Update the pacer service",
        "unverifiedService" => "Check the pacer service version",
        "install" => "pacer needs its command-line tool",
        "welcome" => "Welcome to pacer",
        "consent" => "Set up pacer",
        "existing" => "You already have pacer",
        "incomplete" => "This copy of pacer is incomplete",
        "foreign" => "Another pacer is running",
        "relink" => "pacer's terminal command was removed",
        "protocol" => "Unable to connect to pacer",
        "installing" => "Installing update",
        "rollingBack" => "Restoring the previous version",
        "restored" => "Previous version restored",
        "recoveryFailed" => "Recovery needs attention",
        _ => "Starting pacer…",
    };
    let alert = matches!(state, "stuck" | "recoveryFailed");
    shell.tray_alert.store(alert, Ordering::SeqCst);
    set_error_dot(app, alert);
    if changed {
        update_tray(
            app,
            TrayModel {
                title: title.into(),
                paused: false,
                tooltip: title.into(),
                alert,
            },
        );
    }
}
fn create_recovery_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("tray").is_some() {
        return Ok(());
    }
    let nav = app.clone();
    let current = Arc::new(Mutex::new(None::<Url>));
    let loaded = current.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "tray",
        WebviewUrl::App("index.html?compact=1".into()),
    )
    .incognito(cfg!(feature = "ota-fixture"))
    .title("pacer")
    .inner_size(TRAY_WIDTH, 440.)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .on_page_load(move |window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            *loaded.lock().unwrap() = Some(payload.url().clone());
            render_diagnosis(window.app_handle());
        }
    })
    .on_navigation(move |url| {
        if shell_action(&nav, url, current.lock().unwrap().as_ref()) {
            return false;
        }
        shell_url(url) && matches!(url.path(), "/" | "/index.html")
    })
    .build()?;
    let blur = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let _ = blur.hide();
        }
    });
    Ok(())
}
fn activate(app: &AppHandle, origin: &str, mut auth: Url) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let mut granted = shell.granted.lock().unwrap();
    if !granted.iter().any(|g| g == origin) {
        app.add_capability(
            CapabilityBuilder::new(format!("service-{}", auth.port_or_known_default().unwrap()))
                .local(false)
                .window("main")
                .remote(format!("{origin}/*"))
                .permission("allow-setLaunchAtLogin")
                .permission("allow-setTheme")
                .permission("allow-client-control")
                .permission("allow-notifyRoute")
                .permission("allow-session-expired")
                .permission("allow-session-ready")
                .permission("allow-desktop-version")
                .permission("allow-host-file-actions")
                .permission("allow-open-session-file")
                .permission("allow-rounded-window-supported")
                .permission("allow-native-titlebar-supported")
                .permission("allow-desktop-update-connection")
                .permission("allow-native-validation-setup")
                .permission("allow-windowMinimize")
                .permission("allow-windowToggleMaximize")
                .permission("allow-windowClose")
                .permission("core:window:allow-start-dragging")
                .permission("core:window:allow-internal-toggle-maximize"),
        )
        .map_err(|e| e.to_string())?;
        app.add_capability(
            CapabilityBuilder::new(format!(
                "tray-service-{}",
                auth.port_or_known_default().unwrap()
            ))
            .local(false)
            .window("tray")
            .remote(format!("{origin}/*"))
            .permission("allow-tray-resize")
            .permission("allow-client-control")
            .permission("allow-tray-open")
            .permission("allow-tray-hide")
            .permission("allow-app-quit")
            .permission("allow-session-expired"),
        )
        .map_err(|e| e.to_string())?;
        granted.push(origin.into());
    }
    if let Some(window) = app.get_webview_window("tray") {
        if cfg!(feature = "ota-fixture") || window.url().is_ok_and(|url| shell_url(&url)) {
            let _ = window.destroy();
        }
    }
    *shell.diagnosis.lock().unwrap() = None;
    if let Some(tray) = app.tray_by_id("pacer") {
        let _ = tray.set_tooltip(Some("pacer"));
    }
    *shell.origin.lock().unwrap() = Some(origin.into());
    shell.recovery.lock().unwrap().clear();
    auth.set_fragment(Some(shell.route.lock().unwrap().trim_start_matches('#')));
    let window = app.get_webview_window("main").ok_or("Missing window")?;
    if let Some(version) = shell.old_service_ack.lock().unwrap().as_deref() {
        let label = if logic::service_release(env!("CARGO_PKG_VERSION"), Some(version)) == logic::ServiceRelease::Older {
            format!("older service {}", logic::display_service_release(Some(version)))
        } else { "service version unverified".into() };
        let _ = window.set_title(&format!("pacer — {label}"));
    } else {
        let _ = window.set_title("pacer");
    }
    window.navigate(auth)
        .map_err(|_| "Unable to load the desktop sign-in page".into())
}
fn set_error_dot(app: &AppHandle, error: bool) {
    if let Some(tray) = app.tray_by_id("pacer") {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
            let (width, height) = (icon.width(), icon.height());
            let mut rgba = icon.rgba().to_vec();
            if error {
                let radius = (width.min(height) / 5).max(2) as i32;
                let cx = width as i32 - radius - 1;
                let cy = height as i32 - radius - 1;
                for y in 0..height as i32 {
                    for x in 0..width as i32 {
                        if (x - cx).pow(2) + (y - cy).pow(2) <= radius.pow(2) {
                            let i = (y as usize * width as usize + x as usize) * 4;
                            rgba[i..i + 4].copy_from_slice(&[220, 50, 50, 255]);
                        }
                    }
                }
            }
            let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, width, height)));
            let _ = tray.set_icon_as_template(!error);
        }
    }
}
fn update_tray(app: &AppHandle, model: TrayModel) {
    if let Err(e) = render_tray(app, model) {
        desktop_log!("Unable to update pacer tray: {e}");
    }
}
fn render_tray(app: &AppHandle, model: TrayModel) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("pacer") else {
        return Ok(());
    };
    let menu = Menu::new(app)?;
    let online = app.state::<Shell>().session.lock().unwrap().is_some();
    let old_service = app.state::<Shell>().old_service_ack.lock().unwrap().clone();
    if let Some(version) = &old_service {
        let label = if logic::service_release(env!("CARGO_PKG_VERSION"), Some(version)) == logic::ServiceRelease::Older {
            format!("Service {} needs an update", logic::display_service_release(Some(version)))
        } else { "Service version unverified".into() };
        menu.append(&MenuItem::with_id(app, "old-service", &label, false, None::<&str>)?)?;
    }
    app.state::<Shell>()
        .actions
        .lock()
        .unwrap()
        .insert("pause".into(), actions::pause(model.paused));
    for (id, label, enabled) in [
        ("open", "Open pacer", true),
        (
            "pause",
            if model.paused { "Resume" } else { "Pause 1h" },
            online,
        ),
        ("quit", "Quit", true),
    ] {
        menu.append(&MenuItem::with_id(app, id, label, enabled, None::<&str>)?)?;
    }
    #[cfg(target_os = "linux")]
    menu.append(&MenuItem::with_id(
        app,
        "popover",
        "Show popover",
        true,
        None::<&str>,
    )?)?;
    tray.set_title(Some(&model.title))?;
    let tooltip = old_service
        .map(|version| if logic::service_release(env!("CARGO_PKG_VERSION"), Some(&version)) == logic::ServiceRelease::Older {
            format!("pacer — service {} needs an update", logic::display_service_release(Some(&version)))
        } else { "pacer — service version unverified".into() })
        .unwrap_or(model.tooltip);
    tray.set_tooltip(Some(&tooltip))?;
    if app.state::<Shell>().tray_alert.swap(model.alert, Ordering::SeqCst) != model.alert {
        set_error_dot(app, model.alert);
    }
    tray.set_menu(Some(menu))
}
fn dispatch_action(app: &AppHandle, action: Value) {
    let Some(dispatch) = actions::dispatch(&action) else {
        return;
    };
    let session = app.state::<Shell>().session.lock().unwrap().clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(confirmation) = action["confirm"].as_str() {
            if native_dialog(confirmation, false).await.is_none() {
                return;
            }
        }
        if let actions::Dispatch::Open(route) = dispatch {
            navigate(&app, &route);
            return;
        }
        let Some(session) = session else {
            return;
        };
        if let actions::Dispatch::Op { op, mut params } = dispatch {
            if op == "task.answer" && params.get("text").is_none() {
                let Some(answer) = native_dialog("Answer the executor's question", true).await
                else {
                    return;
                };
                if answer.trim().is_empty() {
                    return;
                }
                params["text"] = Value::String(answer);
            }
            if session.op(&op, &params).await.is_err() {
                let _ = native_dialog(
                    "The action could not be completed. Check pacer and try again.",
                    false,
                )
                .await;
            }
            if let Ok(snapshot) = session.json("/v3/snapshot").await {
                update_tray(&app, TrayModel::from_snapshot(&snapshot));
            }
        }
    });
}
// Dialog strings are argv, never interpolated into AppleScript or a shell.
#[cfg(target_os = "macos")]
async fn native_dialog(message: &str, answer: bool) -> Option<String> {
    let script = if answer {
        "on run argv\nset r to display dialog (item 1 of argv) default answer \"\" with title \"pacer\" buttons {\"Cancel\", \"Answer\"} default button \"Answer\"\nreturn text returned of r\nend run"
    } else {
        "on run argv\ndisplay dialog (item 1 of argv) with title \"pacer\" buttons {\"Cancel\", \"Continue\"} default button \"Continue\"\nreturn \"ok\"\nend run"
    };
    let output = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", script, message])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8(output.stdout)
            .ok()?
            .trim_end_matches('\n')
            .into(),
    )
}
// No native dialog dependency on Linux. Actions needing input remain in the web UI.
#[cfg(not(target_os = "macos"))]
async fn native_dialog(_message: &str, _answer: bool) -> Option<String> {
    None
}
#[cfg(feature = "ota-fixture")]
fn notify(_app: &AppHandle, _notification: notifications::Notification) {}
#[cfg(all(not(target_os = "macos"), not(feature = "ota-fixture")))]
fn notify(app: &AppHandle, notification: notifications::Notification) {
    let _ = app
        .notification()
        .builder()
        .title(notification.title)
        .body(notification.body)
        .extra("route", notification.route)
        .show();
}
#[cfg(all(target_os = "macos", not(feature = "ota-fixture")))]
fn notify(app: &AppHandle, notification: notifications::Notification) {
    // Each category has stable, unique action ids so later notifications cannot remap earlier buttons.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let index = NEXT.fetch_add(1, Ordering::Relaxed);
    let category = format!("pacer-attention-{index}");
    // Keep button mappings for the last 32 notifications only.
    if index >= 32 {
        let stale = format!("pacer-attention-{}-", index - 32);
        app.state::<Shell>()
            .actions
            .lock()
            .unwrap()
            .retain(|id, _| !id.starts_with(&stale));
    }
    let actions: Vec<_> = notification
        .actions
        .iter()
        .enumerate()
        .map(|(n, action)| {
            let id = format!("{category}-{n}");
            app.state::<Shell>()
                .actions
                .lock()
                .unwrap()
                .insert(id.clone(), action.clone());
            Action::builder(
                id,
                notifications::clean(action["label"].as_str().unwrap_or("Open pacer"), 40),
            )
            .build()
        })
        .collect();
    let _ = app
        .notification()
        .register_action_types(vec![ActionType::builder(&category)
            .actions(actions)
            .build()]);
    let _ = app
        .notification()
        .builder()
        .title(notification.title)
        .body(notification.body)
        .action_type_id(category)
        .extra("route", notification.route)
        .show();
}
fn open_external(url: &Url) {
    #[cfg(target_os = "macos")]
    let opener = "/usr/bin/open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    let _ = std::process::Command::new(opener).arg(url.as_str()).spawn();
}
/// Only watch packaged macOS launches; development executables have no bundle to reopen.
#[cfg(target_os = "macos")]
fn watch_bundle(app: AppHandle, executable: std::path::PathBuf, started: logic::BundleIdentity) {
    let bundle = executable
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .unwrap()
        .to_owned();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if app.state::<Shell>().maintenance.load(Ordering::SeqCst) {
                continue;
            }
            match logic::bundle_replaced(&executable, &started) {
                Ok(false) => continue,
                Err(error) => {
                    desktop_log!("Unable to check pacer bundle: {error}");
                    continue;
                }
                Ok(true) => {}
            }
            let hidden = app
                .get_webview_window("main")
                .is_some_and(|window| !window.is_visible().unwrap_or(true));
            let route = app.state::<Shell>().route.lock().unwrap().clone();
            // All variable data is argv. Wait for exit so the single-instance plugin
            // cannot redirect the new launch back into this obsolete process.
            let mut command = std::process::Command::new("/bin/sh");
            command.args([
                "-c",
                "sleep 1; while kill -0 \"$1\" 2>/dev/null; do sleep 1; done; shift; exec /usr/bin/open -n \"$@\"",
                "pacer-relaunch",
            ])
                .arg(std::process::id().to_string())
                .arg(&bundle)
                .arg("--args")
                .arg(format!("--pacer-relaunch-route={route}"));
            if hidden {
                command.arg("--pacer-relaunch-hidden");
            }
            command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            // Commit to relaunch only through Tauri's normal shutdown. The Exit
            // event schedules the helper, which waits for this PID to disappear.
            if app.state::<Shell>().maintenance.load(Ordering::SeqCst) {
                continue;
            }
            *app.state::<Shell>().relaunch.lock().unwrap() = Some(command);
            app.exit(0);
            return;
        }
    });
}

fn main() {
    capture::initialize_build_identity();
    // Build smoke checks run before GUI initialization or service discovery.
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--pacer-identity") => {
            let mut identity = pacer_desktop::ota::trust::build_identity();
            identity.as_object_mut().unwrap().extend(serde_json::json!({ "schema": 1, "role": "desktop", "bundleId": "dev.pacer.desktop", "version": env!("CARGO_PKG_VERSION"), "arch": std::env::consts::ARCH }).as_object().unwrap().clone());
            #[cfg(feature = "ota-fixture")]
            {
                identity["fixtureIsolationProtocol"] = serde_json::json!(1);
            }
            println!("{identity}");
            return;
        }
        _ => {}
    }
    desktop_log!(
        "pacer lifecycle: desktop starting version {}",
        env!("CARGO_PKG_VERSION")
    );
    #[cfg(target_os = "macos")]
    let bundle_started = std::env::current_exe().ok().and_then(|executable| {
        let macos = executable.parent()?;
        let contents = macos.parent()?;
        let bundle = contents.parent()?;
        if macos.file_name()? != "MacOS"
            || contents.file_name()? != "Contents"
            || bundle.extension()? != "app"
        {
            return None;
        }
        match logic::bundle_identity(&executable) {
            Ok(identity) => Some((executable, identity)),
            Err(error) => {
                desktop_log!("Unable to read initial pacer bundle identity: {error}");
                None
            }
        }
    });
    let shell = Shell::default();
    let maintenance_launch = std::env::args().any(|argument| argument == "--pacer-maintenance-launch");
    if let Some(trust) = pacer_desktop::ota::trust::ReleaseTrust::configured() {
        match pacer_desktop::ota::control::read_launch_ticket(&trust) {
            Ok(ticket) => {
                desktop_log!("pacer lifecycle: native maintenance launch={}", ticket.is_some());
                if maintenance_launch && ticket.is_none() {
                    desktop_log!("Native maintenance launch ticket is missing");
                    std::process::exit(2);
                }
                shell.maintenance.store(ticket.is_some(), Ordering::SeqCst);
                *shell.navigation.lock().unwrap() =
                    pacer_desktop::ota::control::NavigationState::with_ticket(ticket)
                        .expect("validated native ticket");
            }
            Err(_) => {
                desktop_log!("Native maintenance launch could not be verified");
                std::process::exit(2);
            }
        }
    } else if maintenance_launch {
        desktop_log!("Native maintenance launch trust is unavailable");
        std::process::exit(2);
    }
    let app = tauri::Builder::default();
    #[cfg(not(feature = "ota-fixture"))]
    let app = app.plugin(tauri_plugin_single_instance::init(|app, args, _| {
        for arg in args {
            if arg.starts_with("pacer://") {
                navigate(app, &arg);
            }
        }
        show(app);
    }));
    let app = app.plugin(tauri_plugin_positioner::init());
    #[cfg(not(feature = "ota-fixture"))]
    let app = app
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin({
            let builder = tauri_plugin_autostart::Builder::new();
            #[cfg(target_os = "macos")]
            let builder =
                builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
            // Linux uses the plugin's XDG autostart desktop entry.
            builder.build()
        })
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["tray"])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        );
    let app = app
        .manage(shell)
        .invoke_handler(tauri::generate_handler![
            client_control::client_control,
            setLaunchAtLogin,
            setTheme,
            notifyRoute,
            tray_resize,
            tray_open,
            tray_hide,
            app_quit,
            session_expired,
            session_ready,
            desktop_version,
            host_file_actions,
            open_session_file,
            rounded_window_supported,
            native_titlebar_supported,
            desktop_update_connection,
            native_validation_setup,
            windowMinimize,
            windowToggleMaximize,
            windowClose
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Some(route) = std::env::args().find_map(|arg| {
                arg.strip_prefix("--pacer-relaunch-route=")
                    .and_then(logic::route)
            }) {
                *handle.state::<Shell>().route.lock().unwrap() = route;
            }
            let nav = handle.clone();
            // WKWebView can have no URL during navigation policy callbacks. Cache
            // completed page loads for source checks; never query the webview there.
            let current = Arc::new(Mutex::new(None::<Url>));
            let loaded = current.clone();
            let builder =
                tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .visible(!std::env::args().any(|arg| arg == "--pacer-relaunch-hidden"))
                    .incognito(cfg!(feature = "ota-fixture"))
                    .title("pacer")
                    .inner_size(1120., 760.)
                    .min_inner_size(720., 520.)
                    .decorations(cfg!(target_os = "macos"))
                    .transparent(true)
                    .on_page_load(move |window, payload| {
                        if payload.event() != tauri::webview::PageLoadEvent::Finished {
                            window
                                .app_handle()
                                .state::<Shell>()
                                .navigation
                                .lock()
                                .unwrap()
                                .invalidate();
                            return;
                        }
                        *loaded.lock().unwrap() = Some(payload.url().clone());
                        check_main_document(&window, payload.url());
                        if shell_url(payload.url()) {
                            render_diagnosis(window.app_handle());
                        }
                        if !matches!(payload.url().path(), "/app" | "/app/") {
                            return;
                        }
                        let app = window.app_handle().clone();
                        let origin = app.state::<Shell>().origin.lock().unwrap().clone();
                        if let Some(origin) = origin {
                            if logic::local_origin(payload.url()).as_deref() == Some(&origin) {
                                if let Some(version) = app.state::<Shell>().old_service_ack.lock().unwrap().clone() {
                                    show_service_version_notice(&window, &version);
                                }
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || {
                                    if handle.state::<Shell>().origin.lock().unwrap().as_deref()
                                        == Some(&origin)
                                    {
                                        if let Err(e) = create_tray_window(&handle, &origin) {
                                            desktop_log!("Unable to create pacer tray window: {e}");
                                        }
                                    }
                                });
                            }
                        }
                    })
                    .on_navigation(move |url| {
                        let current = current.lock().unwrap().clone();
                        if shell_action(&nav, url, current.as_ref()) {
                            return false;
                        }
                        let origin = nav.state::<Shell>().origin.lock().unwrap().clone();
                        match logic::main_navigation(url, current.as_ref(), origin.as_deref()) {
                            logic::Navigation::Allow => true,
                            logic::Navigation::OpenExternal => {
                                open_external(url);
                                false
                            }
                            logic::Navigation::Block => false,
                        }
                    });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let window = builder.build()?;
            if let Ok(path) = app.path().app_config_dir() {
                if let Ok(bytes) = std::fs::read(path.join("theme.json")) {
                    if let Ok(theme) = serde_json::from_slice::<String>(&bytes) {
                        let _ = apply_theme(&window, &theme);
                    }
                }
            }
            let events = handle.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(w) = events.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                tauri::WindowEvent::Focused(true) => {
                    events.state::<Shell>().retry.store(true, Ordering::SeqCst);
                }
                _ => {}
            });
            TrayIconBuilder::with_id("pacer")
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray.png"
                ))?)
                .icon_as_template(true)
                .tooltip("pacer")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    #[cfg(not(target_os = "linux"))]
                    tauri_plugin_positioner::on_tray_event(app, &event);
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        toggle_tray(app);
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "quit" => app.exit(0),
                        "open" => show(app),
                        #[cfg(target_os = "linux")]
                        "popover" => toggle_tray(app),
                        _ => {
                            let action = app
                                .state::<Shell>()
                                .actions
                                .lock()
                                .unwrap()
                                .get(id)
                                .cloned();
                            if let Some(action) = action {
                                dispatch_action(app, action);
                            } else {
                                navigate(app, id);
                            }
                        }
                    }
                })
                .build(app)?;
            update_tray(&handle, TrayModel::from_snapshot(&Value::Null));
            #[cfg(not(feature = "ota-fixture"))]
            {
                let links = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        navigate(&links, url.as_str());
                    }
                });
                if let Some(urls) = app.deep_link().get_current()? {
                    for url in urls {
                        navigate(&handle, url.as_str());
                    }
                }
                let notifications = handle.clone();
                app.notification().on_action(move |action| {
                    let mapped = notifications
                        .state::<Shell>()
                        .actions
                        .lock()
                        .unwrap()
                        .get(action.action_id())
                        .cloned();
                    if let Some(mapped) = mapped {
                        dispatch_action(&notifications, mapped);
                        return;
                    }
                    let target = logic::route(action.action_id()).or_else(|| {
                        action
                            .notification()
                            .and_then(|n| n.extra().get("route"))
                            .and_then(Value::as_str)
                            .and_then(logic::route)
                    });
                    if let Some(target) = target {
                        navigate(&notifications, &target);
                    }
                })?;
                #[cfg(target_os = "macos")]
                approvals::request_notifications();
            }
            tauri::async_runtime::spawn(client::monitor_approvals(handle.clone()));
            tauri::async_runtime::spawn(client::watch_startup(handle.clone()));
            #[cfg(target_os = "macos")]
            if let Some((executable, started)) = bundle_started {
                watch_bundle(handle.clone(), executable, started);
            }
            tauri::async_runtime::spawn(client::run(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("start pacer desktop");
    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        match _event {
            tauri::RunEvent::Reopen { .. } => show(_app),
            tauri::RunEvent::Exit => {
                if _app.state::<Shell>().maintenance.load(Ordering::SeqCst) {
                    _app.state::<Shell>().relaunch.lock().unwrap().take();
                    return;
                }
                if let Some(mut command) = _app.state::<Shell>().relaunch.lock().unwrap().take() {
                    if let Err(error) = command.spawn() {
                        desktop_log!("Unable to schedule pacer relaunch: {error}");
                    }
                }
            }
            _ => {}
        }
    });
}
