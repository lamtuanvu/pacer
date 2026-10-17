#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod client;
mod logic;
mod tray_model;

use reqwest::Url;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::{Action, ActionType, NotificationExt};
use tray_model::TrayModel;

struct Shell {
    origin: Mutex<Option<String>>,
    route: Mutex<String>,
    recovery: Mutex<String>,
    granted: Mutex<Vec<String>>,
    start: AtomicBool,
    retry: AtomicBool,
}
impl Default for Shell {
    fn default() -> Self {
        Self {
            origin: Mutex::new(None),
            route: Mutex::new("#/".into()),
            recovery: Mutex::new(String::new()),
            granted: Mutex::new(Vec::new()),
            start: AtomicBool::new(false),
            retry: AtomicBool::new(false),
        }
    }
}
fn authorized(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    let url = window.url().map_err(|_| "Unknown caller")?;
    let origin = logic::local_origin(&url);
    if window.label() != "main"
        || origin.is_none()
        || origin != *app.state::<Shell>().origin.lock().unwrap()
    {
        return Err("IPC is restricted to the active local service".into());
    }
    Ok(())
}
#[allow(non_snake_case)]
#[tauri::command]
fn setLaunchAtLogin(window: WebviewWindow, app: AppHandle, enabled: bool) -> Result<(), String> {
    authorized(&window, &app)?;
    launch_at_login(&app, enabled)
}
fn launch_at_login(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    (if enabled {
        manager.enable()
    } else {
        manager.disable()
    })
    .map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("pacer") {
        // Next snapshot rebuilds the check mark; the native menu toggle updates immediately itself.
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
fn recovery(app: &AppHandle, state: &str) {
    let shell = app.state::<Shell>();
    *shell.origin.lock().unwrap() = None;
    let mut current = shell.recovery.lock().unwrap();
    if *current == state {
        return;
    }
    *current = state.into();
    if let Some(w) = app.get_webview_window("main") {
        let base = if cfg!(target_os = "windows") {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        if let Ok(url) = Url::parse(&format!("{base}/index.html?state={state}")) {
            let _ = w.navigate(url);
        }
    }
    update_tray(app, TrayModel::from_snapshot(&Value::Null));
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
                .permission("allow-notifyRoute"),
        )
        .map_err(|e| e.to_string())?;
        granted.push(origin.into());
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
    menu.append(&MenuItem::new(app, &model.planner, false, None::<&str>)?)?;
    for (title, items) in [("Needs you", model.needs), ("Running", model.running)] {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::new(app, title, false, None::<&str>)?)?;
        for (n, item) in items.into_iter().enumerate() {
            let id = item
                .route
                .clone()
                .unwrap_or_else(|| format!("disabled-{title}-{n}"));
            menu.append(&MenuItem::with_id(
                app,
                id,
                item.label.replace('&', "&&"),
                item.route.is_some(),
                None::<&str>,
            )?)?;
        }
    }
    for executor in model.executors {
        menu.append(&MenuItem::new(app, executor, false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    // TODO: Enable Pause delegation and add Switch strategy when service operations exist.
    for (id, label, enabled) in [
        ("#/delegate", "Delegate a task…", true),
        ("open", "Open pacer", true),
        ("pause", "Pause delegation for 1 hour", false),
    ] {
        menu.append(&MenuItem::with_id(app, id, label, enabled, None::<&str>)?)?;
    }
    menu.append(&CheckMenuItem::with_id(
        app,
        "login",
        "Launch at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit pacer",
        true,
        None::<&str>,
    )?)?;
    tray.set_title(Some(&model.title))?;
    tray.set_menu(Some(menu))
}
fn notify(app: &AppHandle, data: &Value, preference: &str) {
    if !logic::should_notify(data, preference) {
        return;
    }
    let target = data["route"]
        .as_str()
        .and_then(logic::route)
        .or_else(|| {
            data["taskId"]
                .as_str()
                .and_then(|id| logic::route(&format!("/review/{id}")))
        })
        .unwrap_or_else(|| "#/".into());
    let actions: Vec<_> = data["actions"]
        .as_array()
        .into_iter()
        .flatten()
        .take(2)
        .filter_map(|a| {
            let route = a["route"].as_str().and_then(logic::route)?;
            Some(Action::builder(route, a["label"].as_str().unwrap_or("Open pacer")).build())
        })
        .collect();
    let category = "pacer-alert";
    let _ = app
        .notification()
        .register_action_types(vec![ActionType::builder(category).actions(actions).build()]);
    let _ = app
        .notification()
        .builder()
        .title(data["title"].as_str().unwrap_or("pacer"))
        .body(data["body"].as_str().unwrap_or(""))
        .action_type_id(category)
        .extra("route", target)
        .show();
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
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
            notifyRoute
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let nav = handle.clone();
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("pacer")
                    .inner_size(1120., 760.)
                    .min_inner_size(720., 520.)
                    .on_navigation(move |url| {
                        let state = nav.state::<Shell>();
                        let local = url.scheme() == "tauri" && url.host_str() == Some("localhost");
                        if local
                            && matches!(url.path(), "/start" | "/retry")
                            && nav
                                .get_webview_window("main")
                                .and_then(|w| w.url().ok())
                                .is_some_and(|u| u.scheme() == "tauri")
                        {
                            if url.path() == "/start" {
                                state.start.store(true, Ordering::SeqCst);
                            } else {
                                state.retry.store(true, Ordering::SeqCst);
                            }
                            return false;
                        }
                        if url.as_str()
                            == "https://github.com/lamtuanvu/pacer/blob/main/docs/install.md"
                            && nav
                                .get_webview_window("main")
                                .and_then(|w| w.url().ok())
                                .is_some_and(|u| u.scheme() == "tauri")
                        {
                            let _ = std::process::Command::new("/usr/bin/open")
                                .arg(url.as_str())
                                .spawn();
                            return false;
                        }
                        if local && matches!(url.path(), "/" | "/index.html") {
                            return true;
                        }
                        let origin = state.origin.lock().unwrap().clone();
                        let current = nav.get_webview_window("main").and_then(|w| w.url().ok());
                        if logic::external_link(url, current.as_ref(), origin.as_deref()) {
                            let _ = std::process::Command::new("/usr/bin/open")
                                .arg(url.as_str())
                                .spawn();
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
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "quit" => app.exit(0),
                        "open" => show(app),
                        "login" => {
                            let enabled = !app.autolaunch().is_enabled().unwrap_or(false);
                            if let Err(e) = launch_at_login(app, enabled) {
                                eprintln!("Unable to change launch at login: {e}");
                            }
                        }
                        _ => navigate(app, id),
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
            tauri::async_runtime::spawn(client::run(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("start pacer desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::Reopen { .. } = event {
            show(app);
        }
    });
}
