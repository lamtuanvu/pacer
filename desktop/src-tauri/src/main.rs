#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod actions;
mod approvals;
mod client;
mod logic;
mod notifications;
mod tray_model;

use reqwest::Url;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
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

struct Shell {
    origin: Mutex<Option<String>>,
    route: Mutex<String>,
    recovery: Mutex<String>,
    granted: Mutex<Vec<String>>,
    waiting: Mutex<Option<String>>,
    diagnosis: Mutex<Option<logic::Diagnosis>>,
    retry: AtomicBool,
    session: Mutex<Option<client::Session>>,
    expired: tokio::sync::Notify,
    actions: Mutex<std::collections::HashMap<String, Value>>,
}
impl Default for Shell {
    fn default() -> Self {
        Self {
            origin: Mutex::new(None),
            route: Mutex::new("#/".into()),
            recovery: Mutex::new(String::new()),
            granted: Mutex::new(Vec::new()),
            waiting: Mutex::new(None),
            diagnosis: Mutex::new(None),
            retry: AtomicBool::new(false),
            session: Mutex::new(None),
            expired: tokio::sync::Notify::new(),
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
// Runs in the trusted service document, including script-free error pages. Also
// recognizes pages from older services which do not yet carry the marker.
const CHECK_SESSION_PAGE: &str = r#"if (document.querySelector('[data-pacer-session-ended]') || (!document.getElementById('app') && /Session ended|This link has expired/.test(document.body.textContent))) { window.__TAURI__?.core.invoke('session_expired').catch(() => {}); }"#;

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
fn create_tray_window(app: &AppHandle, origin: &str) -> tauri::Result<()> {
    if app.get_webview_window("tray").is_some() {
        return Ok(());
    }
    let nav = app.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "tray",
        WebviewUrl::External(
            Url::parse(&format!("{origin}/app/tray.html")).expect("validated service origin"),
        ),
    )
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
            let _ = window.eval(CHECK_SESSION_PAGE);
        }
    })
    .on_navigation(move |url| {
        let origin = nav.state::<Shell>().origin.lock().unwrap().clone();
        logic::command_authorized("tray", "tray", url, origin.as_deref())
            && url.path() == "/app/tray.html"
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
            eprintln!("Unable to show pacer status: {error}");
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
fn shell_action(app: &AppHandle, label: &str, url: &Url) -> bool {
    if url.as_str()
        != "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
    {
        return false;
    }
    let bundled = app
        .get_webview_window(label)
        .and_then(|w| w.url().ok())
        .is_some_and(|current| {
            shell_url(&current) && matches!(current.path(), "/" | "/index.html")
        });
    if !bundled {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn(async {
            let result = tokio::process::Command::new("/usr/bin/open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
                .status().await;
            eprintln!("pacer lifecycle: open Files and Folders settings: {result:?}");
        });
    }
    true
}
fn diagnostic_recovery(app: &AppHandle, diagnosis: &logic::Diagnosis) {
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
                    "oldApp" => "oldApp",
                    "protocol" => "protocol",
                    "permission" => "permission",
                    "install" => "install",
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
        "permission" => "macOS needs your permission",
        "oldApp" => "Update the pacer app",
        "oldService" => "Update pacer",
        "install" => "Install the pacer app",
        "protocol" => "Unable to connect to pacer",
        _ => "Starting pacer…",
    };
    if changed {
        if let Some(tray) = app.tray_by_id("pacer") {
            let _ = tray.set_tooltip(Some(title));
        }
        update_tray(
            app,
            TrayModel {
                title: title.into(),
                paused: false,
            },
        );
    }
}
fn create_recovery_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("tray").is_some() {
        return Ok(());
    }
    let nav = app.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "tray",
        WebviewUrl::App("index.html?compact=1".into()),
    )
    .title("pacer")
    .inner_size(TRAY_WIDTH, 440.)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .on_page_load(|window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            render_diagnosis(window.app_handle());
        }
    })
    .on_navigation(move |url| {
        if shell_action(&nav, "tray", url) {
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
                .permission("allow-notifyRoute")
                .permission("allow-session-expired"),
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
            .permission("allow-tray-open")
            .permission("allow-tray-hide")
            .permission("allow-app-quit")
            .permission("allow-session-expired"),
        )
        .map_err(|e| e.to_string())?;
        granted.push(origin.into());
    }
    if let Some(window) = app.get_webview_window("tray") {
        if window.url().is_ok_and(|url| shell_url(&url)) {
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
    app.get_webview_window("main")
        .ok_or("Missing window")?
        .navigate(auth)
        .map_err(|e| e.to_string())
}
fn update_tray(app: &AppHandle, model: TrayModel) {
    if let Err(e) = render_tray(app, model) {
        eprintln!("Unable to update pacer tray: {e}");
    }
}
fn render_tray(app: &AppHandle, model: TrayModel) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("pacer") else {
        return Ok(());
    };
    let menu = Menu::new(app)?;
    let online = app.state::<Shell>().session.lock().unwrap().is_some();
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
            if let Ok(snapshot) = session.json("/v2/snapshot").await {
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
#[cfg(not(target_os = "macos"))]
fn notify(app: &AppHandle, notification: notifications::Notification) {
    let _ = app
        .notification()
        .builder()
        .title(notification.title)
        .body(notification.body)
        .extra("route", notification.route)
        .show();
}
#[cfg(target_os = "macos")]
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
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            for arg in args {
                if arg.starts_with("pacer://") {
                    navigate(app, &arg);
                }
            }
            show(app);
        }))
        .plugin(tauri_plugin_positioner::init())
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
        )
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            setLaunchAtLogin,
            setTheme,
            notifyRoute,
            tray_resize,
            tray_open,
            tray_hide,
            app_quit,
            session_expired
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let nav = handle.clone();
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("pacer")
                    .inner_size(1120., 760.)
                    .min_inner_size(720., 520.)
                    .on_page_load(|window, payload| {
                        if payload.event() != tauri::webview::PageLoadEvent::Finished {
                            return;
                        }
                        let _ = window.eval(CHECK_SESSION_PAGE);
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
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || {
                                    if handle.state::<Shell>().origin.lock().unwrap().as_deref()
                                        == Some(&origin)
                                    {
                                        if let Err(e) = create_tray_window(&handle, &origin) {
                                            eprintln!("Unable to create pacer tray window: {e}");
                                        }
                                    }
                                });
                            }
                        }
                    })
                    .on_navigation(move |url| {
                        let state = nav.state::<Shell>();
                        let local = shell_url(url);
                        if shell_action(&nav, "main", url) {
                            return false;
                        }
                        if url.as_str()
                            == "https://github.com/lamtuanvu/pacer/blob/main/docs/install.md"
                            && nav
                                .get_webview_window("main")
                                .and_then(|w| w.url().ok())
                                .is_some_and(|u| u.scheme() == "tauri")
                        {
                            open_external(url);
                            return false;
                        }
                        if local && matches!(url.path(), "/" | "/index.html") {
                            return true;
                        }
                        let origin = state.origin.lock().unwrap().clone();
                        let current = nav.get_webview_window("main").and_then(|w| w.url().ok());
                        if logic::external_link(url, current.as_ref(), origin.as_deref()) {
                            open_external(url);
                            return false;
                        }
                        logic::service_navigation(url, origin.as_deref())
                    })
                    .build()?;
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
            tauri::async_runtime::spawn(client::monitor_approvals(handle.clone()));
            tauri::async_runtime::spawn(client::run(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("start pacer desktop");
    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show(_app);
        }
    });
}
