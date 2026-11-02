#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
macro_rules! desktop_log {
    ($($arg:tt)*) => { crate::logging::write(format_args!($($arg)*)) };
}
mod actions;
mod app_menu;
mod approvals;
mod capture;
mod client;
mod ipc_transport;
mod client_control;
mod link;
mod logging;
mod logic;
mod notifications;
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
async fn native_validation_setup(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<permission_setup::SetupResult, String> {
    authorized(&window, &app)?;
    let result = permission_setup::request().await?;
    authorized(&window, &app)?;
    Ok(result)
}

struct Shell {
    takeover: Mutex<Option<TakeoverView>>,
    takeover_progress: Mutex<Option<Value>>,
    /// Unfinished takeover transactions the desktop already ran recovery for.
    takeover_recovery_attempted: Mutex<std::collections::HashSet<String>>,
    /// The main window's document authority and its single-use takeover token.
    main_page: Mutex<logic::MainPage>,
    #[cfg(feature = "ota-fixture")]
    fixture_tray_auth: Mutex<Option<Url>>,
    native: Mutex<Option<Arc<pacer_desktop::ota::control::NativeConnection>>>,
    native_update_error: Mutex<Option<pacer_desktop::ota::OtaError>>,
    navigation: Mutex<pacer_desktop::ota::control::NavigationState>,
    adoption: Mutex<Option<pacer_desktop::ota::control::AdoptionReconnectPlan>>,
    maintenance: AtomicBool,
    /// Whether the last snapshot showed an update or adoption transaction in flight.
    update_transaction: AtomicBool,
    /// Whether the tray icon currently carries the red attention dot.
    tray_alert: AtomicBool,
    #[cfg(target_os = "macos")]
    relaunch: Mutex<Option<std::process::Command>>,
    startup: Mutex<logic::Startup>,
    origin: Mutex<Option<String>>,
    route: Mutex<String>,
    recovery: Mutex<String>,
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
            takeover: Mutex::new(None),
            takeover_progress: Mutex::new(None),
            takeover_recovery_attempted: Mutex::new(Default::default()),
            main_page: Mutex::new(logic::MainPage::default()),
            #[cfg(feature = "ota-fixture")]
            fixture_tray_auth: Mutex::new(None),
            native: Mutex::new(None),
            native_update_error: Mutex::new(None),
            navigation: Mutex::new(Default::default()),
            adoption: Mutex::new(None),
            maintenance: AtomicBool::new(false),
            update_transaction: AtomicBool::new(false),
            tray_alert: AtomicBool::new(false),
            #[cfg(target_os = "macos")]
            relaunch: Mutex::new(None),
            startup: Mutex::new(logic::Startup::default()),
            origin: Mutex::new(None),
            route: Mutex::new(logic::remembered_route("#/")),
            recovery: Mutex::new(String::new()),
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
#[derive(Clone)]
struct TakeoverView {
    candidate: pacer_desktop::ota::takeover::detect::TakeoverCandidate,
    inspection: Value,
}
/// Popover width from the TrayPopover board.
const TRAY_WIDTH: f64 = 340.;

fn authorized(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| shell_url(&url)) {
        return Err("IPC requires the bundled main window".into());
    }
    let _ = app;
    Ok(())
}
fn authorized_tray(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    if window.label() != "tray" || !window.url().is_ok_and(|url| shell_url(&url)) {
        return Err("IPC requires the bundled tray window".into());
    }
    let _ = app;
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
fn desktop_update_connection(
    window: WebviewWindow,
    app: AppHandle,
    supports: Option<Vec<String>>,
) -> Result<Value, String> {
    authorized(&window, &app)?;
    let shell = app.state::<Shell>();
    let alive = shell
        .native
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|native| native.alive());
    let error = *shell.native_update_error.lock().unwrap();
    let takeover = shell.takeover.lock().unwrap().is_some();
    let supports_takeover = supports
        .as_ref()
        .is_some_and(|items| items.iter().any(|item| item == "service-takeover"));
    let mut result = logic::desktop_update_connection(
        pacer_desktop::ota::trust::ReleaseTrust::configured().is_some(),
        alive,
        error,
        takeover,
        supports_takeover,
    );
    if alive {
        if let (Some(user_home), Some(bundled), Ok(config)) = (
            std::env::var_os("HOME"),
            client::bundled_binary(),
            app.path().app_config_dir(),
        ) {
            if pacer_desktop::ota::takeover::detect::read_consent(&config)
                .ok()
                .flatten()
                .is_some_and(|consent| !consent.keep)
                && matches!(
                    link::state(std::path::Path::new(&user_home), &bundled),
                    link::LinkState::Foreign(_)
                )
            {
                result["terminalCommandDifferent"] = serde_json::json!(true);
            }
        }
    }
    Ok(result)
}
#[tauri::command]
fn takeover_open(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized(&window, &app)?;
    if app.state::<Shell>().takeover.lock().unwrap().is_none() {
        return Err("No service takeover was detected".into());
    }
    recovery(&app, "takeover");
    app.state::<Shell>().expired.notify_one();
    Ok(())
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
        if shell_url(url) && window.label()=="main"
            && matches!(url.path(), "" | "/" | "/index.html")
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
    if shell.session.lock().unwrap().is_some() {
        let _ = window.eval(CHECK_SESSION_PAGE);
    }
}

fn show_service_version_notice(window: &WebviewWindow, raw_version: &str) {
    let label = if logic::service_release(env!("CARGO_PKG_VERSION"), Some(raw_version))
        == logic::ServiceRelease::Older
    {
        format!(
            "Service {} is older than this app · New controls are unavailable",
            logic::display_service_release(Some(raw_version))
        )
    } else {
        "Service version unverified · New controls may be unavailable".into()
    };
    let label = serde_json::to_string(&label).unwrap();
    let script = format!(
        r#"(() => {{
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
    }})()"#
    );
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
fn tray_login_item(
    window: WebviewWindow,
    app: AppHandle,
    enabled: Option<bool>,
) -> Result<bool, String> {
    authorized_tray(&window, &app)?;
    #[cfg(feature = "ota-fixture")]
    {
        let _ = enabled;
        Err("Launch at login is unavailable in isolated fixtures".into())
    }
    #[cfg(not(feature = "ota-fixture"))]
    {
        if let Some(enabled) = enabled {
            launch_at_login(&app, enabled)?;
        }
        #[cfg(target_os = "macos")]
        if let Some(enabled) = approvals::launch_at_login_enabled() {
            return Ok(enabled);
        }
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
}
#[tauri::command]
fn app_quit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorized_tray(&window, &app)?;
    app.exit(0);
    Ok(())
}
fn create_tray_window(app: &AppHandle, _origin: &str) -> Result<(), String> {
    if app.get_webview_window("tray").is_some() {
        return Ok(());
    }
    let nav = app.clone();
    let document=Arc::new(Mutex::new(None::<Url>));
    let loaded=document.clone();
    let window = tauri::WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("tray.html?compact=1".into()))
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
        .on_page_load(move |window,payload| {
            if payload.event()==tauri::webview::PageLoadEvent::Finished {
                *loaded.lock().unwrap()=Some(payload.url().clone());
                render_diagnosis_in(window.app_handle(),&["tray"]);
            }
        })
        .on_navigation(move |url| {
            let current=document.lock().unwrap().clone();
            if shell_action(&nav,url,current.as_ref(),false) { return false; }
            match logic::bundled_navigation(url,current.as_ref(),true) {
                logic::Navigation::Allow=>true,
                logic::Navigation::OpenExternal=>{open_external(url);false},
                logic::Navigation::Block=>false,
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
    *app.state::<Shell>().route.lock().unwrap() =
        logic::remembered_route(&logic::route(&route).ok_or("Invalid route")?);
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
        *state.route.lock().unwrap() = logic::remembered_route(&route);
        if let Some(payload) = app_menu::route_payload(&route) {
            app_menu::send_route(app, payload);
        }
        show(app);
    }
}
fn shell_url(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.username().is_empty() && url.password().is_none() && url.port().is_none()
}
fn shell_action(app: &AppHandle, url: &Url, current: Option<&Url>, main: bool) -> bool {
    let source_is_bundled=current.is_some_and(|url|logic::bundled_document(url,!main));
    if app.state::<Shell>().main_page.lock().unwrap().in_shell_state("relink")
        && source_is_bundled && url.as_str()=="tauri://localhost/index.html?state=starting"
        && app
            .state::<Shell>()
            .diagnosis
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|d| d.page == "relink")
    {
        app.state::<Shell>()
            .relink_dismissed
            .store(true, Ordering::SeqCst);
        app.state::<Shell>().startup.lock().unwrap().ready();
        return true; // The bundled document stays loaded.
    }
    if source_is_bundled && url.as_str()=="tauri://localhost/index.html?state=welcome" && app.state::<Shell>().main_page.lock().unwrap().in_shell_state("consent") {
        *app.state::<Shell>().onboarding_page.lock().unwrap() = Some(logic::Onboarding::Welcome);
        return true;
    }
    let bundled = current.is_some_and(|url|logic::bundled_document(url,!main));
    if let Some(action) = logic::shell_action_url(url) {
        if matches!(
            action,
            logic::ShellAction::TakeoverConfirm { .. } | logic::ShellAction::TakeoverDismiss
        ) {
            // Only the token the bundled takeover page received authorizes these.
            // The token is consumed by any well-formed attempt, including a rejected one.
            let candidate = takeover_candidate_key(app);
            if main
                && app
                    .state::<Shell>()
                    .main_page
                    .lock()
                    .unwrap()
                    .authorize_takeover(url, action, candidate.as_deref())
            {
                app.state::<Shell>()
                    .shell_action
                    .lock()
                    .unwrap()
                    .get_or_insert(action);
                app.state::<Shell>().wake.notify_one();
            } else {
                desktop_log!(
                    "pacer lifecycle: rejected a takeover action without a valid page token"
                );
            }
            return true;
        }
        if bundled && app.state::<Shell>().main_page.lock().unwrap().allows_shell_action(action)
        {
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
    if !bundled || !app.state::<Shell>().main_page.lock().unwrap().in_shell_state("permission") {
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
    render_diagnosis_in(app, &["main", "tray"]);
}
fn render_diagnosis_in(app: &AppHandle, labels: &[&str]) {
    let detail = app.state::<Shell>().diagnosis.lock().unwrap().clone();
    if let Some(detail) = detail {
        if let Ok(json) = serde_json::to_string(&detail) {
            for label in labels.iter().copied() {
                let loaded = if label=="main" {app.state::<Shell>().main_page.lock().unwrap().current().is_some()} else {app.state::<ipc_transport::Bridge>().has_page(label)};
                if !loaded {continue;}
                if let Some(window) = app.get_webview_window(label) {
                    if window.url().is_ok_and(|url| shell_url(&url)) {
                        let _ = window.eval(format!("window.renderShell?.({json})"));
                    }
                }
            }
        }
    }
}
/// Binds a takeover token to the candidate the page shows: its registration
/// hash, process incarnation and program identity.
fn takeover_candidate_key(app: &AppHandle) -> Option<String> {
    app.state::<Shell>()
        .takeover
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|view| serde_json::to_string(&view.candidate).ok())
}
/// Delivers inspection, progress and a single-use action token to the bundled
/// takeover page only. Inspection data is never available over IPC.
fn render_takeover(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let inspection = shell
        .takeover
        .lock()
        .unwrap()
        .as_ref()
        .map(|view| view.inspection.clone());
    let progress = shell.takeover_progress.lock().unwrap().clone();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(kind) = shell.main_page.lock().unwrap().takeover_page() else { return; };
    // No action is possible while a transaction runs; only an error re-enables the offer.
    let in_flight = progress.as_ref().is_some_and(|p| p["state"] != "error");
    // Never hold the page lock across webview calls, which run on the main thread.
    // The cached page is cleared when a navigation starts, so a document in
    // flight never receives a valid token, even if the webview still reports
    // the old URL; a token issued just before a navigation is already void.
    let token = if kind == logic::TakeoverPage::Offer && in_flight {
        shell.main_page.lock().unwrap().revoke_takeover_token();
        None
    } else {
        let Ok(random) = pacer_desktop::ota::journal::random_id() else {
            return;
        };
        let candidate = takeover_candidate_key(app);
        let Some(token) = shell
            .main_page
            .lock()
            .unwrap()
            .issue_takeover_token(candidate.as_deref(), random)
        else {
            return;
        };
        Some(token)
    };
    let payload = serde_json::json!({"inspection":inspection,"progress":progress,"token":token});
    // `location` is unforgeable: a document from another origin never gets the payload.
    let _ = window.eval(format!("if (location.protocol === 'tauri:' && location.host === 'localhost') window.renderTakeover?.({payload});"));
}
fn set_takeover_progress(app: &AppHandle, value: Value) {
    *app.state::<Shell>().takeover_progress.lock().unwrap() = Some(value);
    render_takeover(app);
}
fn recovery(app: &AppHandle, state: &str) {
    let shell = app.state::<Shell>();
    shell.main_page.lock().unwrap().shell_state(state);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("pacer");
    }
    shell.origin.lock().unwrap().take();
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
                    "takeover" => "takeover",
                    "takeoverProgress" => "takeoverProgress",
                    "takeoverRestored" => "takeoverRestored",
                    "takeoverFailed" => "takeoverFailed",
                    "foreign" => "foreign",
                    "stuck" => "stuck",
                    "sessionExpired" => "sessionExpired",
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
        desktop_log!("pacer lifecycle: showing the {state} page");
    }
    app.state::<ipc_transport::Bridge>().status(serde_json::json!({"type":"status","status": logic::recovery_status(state),"reason":state}));
    render_diagnosis(app);
    render_takeover(app);
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
        "takeover" => "Use the app's service",
        "takeoverProgress" => "Replacing the pacer service",
        "takeoverRestored" => "Kept your current service",
        "takeoverFailed" => "Service replacement needs attention",
        "protocol" => "Unable to connect to pacer",
        "installing" => "Installing update",
        "rollingBack" => "Restoring the previous version",
        "restored" => "Previous version restored",
        "recoveryFailed" => "Recovery needs attention",
        _ => "Starting pacer…",
    };
    let alert = matches!(state, "stuck" | "recoveryFailed" | "takeoverFailed");
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
                transaction: None,
            },
        );
    }
}
fn create_recovery_tray(app: &AppHandle) -> tauri::Result<()> {
    create_tray_window(app, "").map_err(|error| tauri::Error::Io(std::io::Error::other(error)))
}
fn activate(app: &AppHandle, origin: &str, auth: Url) -> Result<(), String> {
    let shell = app.state::<Shell>();
    *shell.origin.lock().unwrap() = Some(origin.into());
    *shell.diagnosis.lock().unwrap() = None;
    shell.recovery.lock().unwrap().clear();
    shell.main_page.lock().unwrap().shell_state("connected");
    let current=shell.main_page.lock().unwrap().current().cloned();
    if let (Some(window),Some(url))=(app.get_webview_window("main"),current) {
        check_main_document(&window,&url);
    }
    if let Some(window)=app.get_webview_window("main") {
        let title=match shell.old_service_ack.lock().unwrap().as_deref() {
            Some(version) if logic::display_service_release(Some(version))=="Unknown"=>"pacer — service version unverified".to_owned(),
            Some(version)=>format!("pacer — older service {version}"),
            None=>"pacer".into(),
        };
        let _=window.set_title(&title);
    }
    let _ = auth;
    let warning=shell.old_service_ack.lock().unwrap().as_deref().map(|version| {
        let release=logic::display_service_release(Some(version));
        if release=="Unknown" {"Service version unverified. Update pacer's service to use the current controls.".to_owned()}
        else {format!("Older service {release}. Update pacer's service to use the current controls.")}
    });
    app.state::<ipc_transport::Bridge>().status(serde_json::json!({"type":"status","status":"connected","warning":warning}));
    create_tray_window(app, origin)?;
    Ok(())
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
    if let Some(transaction) = model.transaction {
        app.state::<Shell>()
            .update_transaction
            .store(transaction, Ordering::SeqCst);
    }
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
        let label = if logic::service_release(env!("CARGO_PKG_VERSION"), Some(version))
            == logic::ServiceRelease::Older
        {
            format!(
                "Service {} needs an update",
                logic::display_service_release(Some(version))
            )
        } else {
            "Service version unverified".into()
        };
        menu.append(&MenuItem::with_id(
            app,
            "old-service",
            &label,
            false,
            None::<&str>,
        )?)?;
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
        .map(|version| {
            if logic::service_release(env!("CARGO_PKG_VERSION"), Some(&version))
                == logic::ServiceRelease::Older
            {
                format!(
                    "pacer — service {} needs an update",
                    logic::display_service_release(Some(&version))
                )
            } else {
                "pacer — service version unverified".into()
            }
        })
        .unwrap_or(model.tooltip);
    tray.set_tooltip(Some(&tooltip))?;
    if app
        .state::<Shell>()
        .tray_alert
        .swap(model.alert, Ordering::SeqCst)
        != model.alert
    {
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
            if !native_dialog(&app, confirmation).await {
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
        if let actions::Dispatch::Op { op, params } = dispatch {
            if op == "task.answer" && params.get("text").is_none() {
                // The dialog plugin has no text input. Use the task's existing answer composer.
                if let Some(id) = params["id"].as_str().or_else(|| params["taskId"].as_str()) {
                    navigate(&app, &format!("#/needs-you?answer={id}"));
                } else {
                    navigate(&app, "#/needs-you");
                }
                return;
            }
            if session.op(&op, &params).await.is_err() {
                let _ = native_dialog(
                    &app,
                    "The action could not be completed. Check pacer and try again.",
                )
                .await;
            }
            if let Ok(snapshot) = session.json("/v3/snapshot").await {
                update_tray(&app, TrayModel::from_snapshot(&snapshot));
            }
        }
    });
}
async fn native_dialog(app: &AppHandle, message: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("pacer")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Continue".into(),
            "Cancel".into(),
        ))
        .show(move |accepted| {
            let _ = send.send(accepted);
        });
    receive.await.unwrap_or(false)
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
            identity.as_object_mut().unwrap().extend(serde_json::json!({ "schema": 1, "role": "desktop", "bundleId": pacer_desktop::ota::trust::APP_ID, "version": env!("CARGO_PKG_VERSION"), "arch": std::env::consts::ARCH }).as_object().unwrap().clone());
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
    let maintenance_launch =
        std::env::args().any(|argument| argument == "--pacer-maintenance-launch");
    if let Some(trust) = pacer_desktop::ota::trust::ReleaseTrust::configured() {
        match pacer_desktop::ota::control::read_launch_ticket(&trust) {
            Ok(ticket) => {
                desktop_log!(
                    "pacer lifecycle: native maintenance launch={}",
                    ticket.is_some()
                );
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
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init());
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
        .manage(ipc_transport::Bridge::default())
        .manage(shell)
        .invoke_handler(tauri::generate_handler![
            app_menu::menu_set_enabled,
            ipc_transport::service_call,
            ipc_transport::service_hello,
            ipc_transport::service_snapshot,
            ipc_transport::service_events,
            ipc_transport::stream_cancel,
            ipc_transport::stream_ack,
            ipc_transport::assistant_turn_stream,
            ipc_transport::task_log_follow,
            ipc_transport::attachment_upload,
            ipc_transport::attachment_list,
            ipc_transport::attachment_read,
            ipc_transport::attachment_delete,
            ipc_transport::terminal_attach,
            ipc_transport::terminal_send,
            ipc_transport::terminal_resize,
            ipc_transport::terminal_take,
            ipc_transport::terminal_release,
            ipc_transport::terminal_detach,
            ipc_transport::terminal_ack,
            client_control::client_control,
            setLaunchAtLogin,
            setTheme,
            notifyRoute,
            tray_resize,
            tray_open,
            tray_hide,
            tray_login_item,
            app_quit,
            session_expired,
            session_ready,
            desktop_version,
            rounded_window_supported,
            native_titlebar_supported,
            desktop_update_connection,
            takeover_open,
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
                *handle.state::<Shell>().route.lock().unwrap() = logic::remembered_route(&route);
            }
            let nav = handle.clone();
            // WKWebView can have no URL during navigation policy callbacks. Cache
            // completed page loads for source checks in Shell::main_page; never
            // query the webview there.
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
                            app_menu::page_started(window.app_handle());
                            window
                                .app_handle()
                                .state::<Shell>()
                                .navigation
                                .lock()
                                .unwrap()
                                .invalidate();
                            window
                                .app_handle()
                                .state::<Shell>()
                                .main_page
                                .lock()
                                .unwrap()
                                .started();
                            return;
                        }
                        window
                            .app_handle()
                            .state::<Shell>()
                            .main_page
                            .lock()
                            .unwrap()
                            .finished(payload.url().clone());
                        check_main_document(&window, payload.url());
                        if shell_url(payload.url()) {
                            desktop_log!(
                                "pacer lifecycle: shell page loaded: {}",
                                payload.url().query().unwrap_or("")
                            );
                            render_diagnosis(window.app_handle());
                            render_takeover(window.app_handle());
                        }
                        if !matches!(payload.url().path(), "/app" | "/app/") {
                            return;
                        }
                        let app = window.app_handle().clone();
                        let origin = app.state::<Shell>().origin.lock().unwrap().clone();
                        if let Some(origin) = origin {
                            if logic::local_origin(payload.url()).as_deref() == Some(&origin) {
                                if let Some(version) =
                                    app.state::<Shell>().old_service_ack.lock().unwrap().clone()
                                {
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
                        let current = nav
                            .state::<Shell>()
                            .main_page
                            .lock()
                            .unwrap()
                            .current()
                            .cloned();
                        if shell_action(&nav, url, current.as_ref(), true) {
                            return false;
                        }
                        match logic::bundled_navigation(url,current.as_ref(),false) {
                            logic::Navigation::Allow=>{nav.state::<Shell>().main_page.lock().unwrap().navigating(url);true},
                            logic::Navigation::OpenExternal=>{open_external(url);false},
                            logic::Navigation::Block=>false,
                        }
                    });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let window = builder.build()?;
            app_menu::install(&handle)?;
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
                    if app_menu::is_app_menu_id(id) {
                        return;
                    }
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

#[cfg(test)]
mod manifest_tests {
    fn assert_no_dialog_or_fs(value: &serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                if let Some(permissions) = fields.get("permissions") {
                    for permission in permissions.as_array().expect("permission array") {
                        let id = permission
                            .as_str()
                            .or_else(|| permission.get("identifier").and_then(|id| id.as_str()))
                            .expect("permission identifier");
                        assert!(
                            !id.starts_with("dialog:") && !id.starts_with("fs:"),
                            "Forbidden capability permission: {id}"
                        );
                    }
                }
                for child in fields.values() {
                    assert_no_dialog_or_fs(child);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    assert_no_dialog_or_fs(child);
                }
            }
            _ => {}
        }
    }
    #[test]
    fn no_static_or_runtime_capability_grants_dialog_or_filesystem_access() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        // Tauri's build output includes every capability file, including TOML and nested files.
        let static_capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        assert_no_dialog_or_fs(&static_capabilities);
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_no_dialog_or_fs(&config["app"]["security"]["capabilities"]);
        for port in [43123, 54321] {
            let origin = format!("http://127.0.0.1:{port}");
            let auth = url::Url::parse(&format!("{origin}/app/")).unwrap();
            let capabilities = super::service_capabilities(&origin, &auth);
            for capability in capabilities {
                let CapabilityFile::Capability(capability) = capability.build() else {
                    panic!("Expected a single runtime capability");
                };
                assert_no_dialog_or_fs(&serde_json::to_value(capability).unwrap());
            }
        }
    }
    #[test]
    fn forbidden_permission_assertion_catches_strings_and_scoped_entries() {
        for permission in [
            serde_json::json!("dialog:default"),
            serde_json::json!("fs:allow-read-file"),
            serde_json::json!({"identifier": "dialog:allow-open", "allow": []}),
            serde_json::json!({"identifier": "fs:default"}),
        ] {
            let capability = serde_json::json!({"nested": [{"permissions": [permission]}]});
            assert!(std::panic::catch_unwind(|| assert_no_dialog_or_fs(&capability)).is_err());
        }
    }
    #[test]
    fn every_local_command_permission_has_a_manifest_command() {
        let main_source = include_str!("main.rs");
        let manifest_source = include_str!("../build.rs");
        let commands = manifest_source
            .split("AppManifest::new().commands(&[")
            .nth(1)
            .expect("AppManifest commands")
            .split("])")
            .next()
            .expect("AppManifest command list");
        for tail in main_source.split(".permission(\"allow-").skip(1) {
            let permission = tail.split('"').next().expect("permission name");
            let command = permission.replace('-', "_");
            assert!(
                commands.contains(&format!("\"{command}\"")),
                "missing AppManifest command {command} for allow-{permission}"
            );
        }
    }
}
