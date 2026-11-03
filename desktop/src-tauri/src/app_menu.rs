//! Native menu projection and the small event contract shared with the service page.

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Mutex};
use tauri::{menu::MenuItem, AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

pub const COMMAND_EVENT: &str = "pacer://command";
pub const ROUTE_EVENT: &str = "pacer://route";
#[derive(Clone, Debug, Serialize)]
pub struct CommandPayload {
    pub id: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct RoutePayload {
    pub hash: String,
}
pub fn route_payload(raw: &str) -> Option<RoutePayload> {
    crate::logic::route(raw).map(|hash| RoutePayload { hash })
}
#[derive(Debug)]
pub struct Item {
    pub section: &'static str,
    pub id: &'static str,
    pub title: &'static str,
    pub accelerator: Option<&'static str>,
}
pub fn model() -> Vec<Item> {
    [
        ("pacer", "go.settings", "Settings…", Some("CmdOrCtrl+,")),
        ("pacer", "native.updates", "Check for Updates…", None),
        ("File", "task.new", "New task", Some("CmdOrCtrl+N")),
        ("File", "view.close", "Close", Some("CmdOrCtrl+W")),
        ("View", "go.dispatch", "Dispatch", Some("CmdOrCtrl+1")),
        ("View", "go.needs-you", "Needs you", Some("CmdOrCtrl+2")),
        ("View", "go.tasks", "Tasks", Some("CmdOrCtrl+3")),
        ("View", "go.terminal", "Workspace", Some("CmdOrCtrl+4")),
        (
            "View",
            "view.panel.left",
            "Toggle left panel",
            Some("CmdOrCtrl+B"),
        ),
        (
            "View",
            "view.panel.terminal",
            "Toggle terminal panel",
            Some("Ctrl+`"),
        ),
        (
            "View",
            "view.panel.right",
            "Toggle right panel",
            Some("Alt+CmdOrCtrl+B"),
        ),
        ("View", "view.find", "Find", Some("CmdOrCtrl+F")),
        ("Go", "go.back", "Back", Some("CmdOrCtrl+[")),
        ("Go", "go.forward", "Forward", Some("CmdOrCtrl+]")),
        ("Go", "go.dispatch", "Dispatch", None),
        ("Go", "go.tasks", "Tasks", None),
        ("Go", "go.needs-you", "Needs you", None),
        ("Help", "help.shortcuts", "Keyboard shortcuts", None),
        ("Help", "native.service-guidance", "Service guidance…", None),
        ("Help", "native.docs", "Documentation", None),
        ("Help", "native.issue", "Report an issue", None),
    ]
    .into_iter()
    .map(|(section, id, title, accelerator)| Item {
        section,
        id,
        title,
        accelerator,
    })
    .collect()
}
pub struct NativeMenu<R: tauri::Runtime = tauri::Wry> {
    items: Vec<(&'static str, MenuItem<R>)>,
    enabled: Mutex<HashSet<String>>,
    page: Mutex<PageBridge>,
}
#[derive(Deserialize)]
pub struct EnabledItem {
    id: String,
    enabled: bool,
}
#[derive(Default)]
struct PageBridge {
    ready: bool,
    pending: Option<RoutePayload>,
}
impl PageBridge {
    fn started(&mut self) {
        self.ready = false;
    }
    fn ready(&mut self) -> Option<RoutePayload> {
        self.ready = true;
        self.pending.take()
    }
    fn route(&mut self, route: RoutePayload) -> Option<RoutePayload> {
        if self.ready {
            Some(route)
        } else {
            self.pending = Some(route);
            None
        }
    }
}
pub fn is_app_menu_id(id: &str) -> bool {
    model().iter().any(|item| item.id == id)
}
fn validate_enabled(items: &[EnabledItem]) -> Result<(), String> {
    if items.len() > model().len()
        || items
            .iter()
            .any(|item| item.id.starts_with("native.") || !is_app_menu_id(&item.id))
    {
        return Err("Unknown menu command".into());
    }
    Ok(())
}
pub fn page_started(app: &AppHandle) {
    if let Some(state) = app.try_state::<NativeMenu>() {
        state.page.lock().unwrap().started();
        state.enabled.lock().unwrap().clear();
        for (id, item) in &state.items {
            if !id.starts_with("native.") {
                let _ = item.set_enabled(*id == "view.close");
            }
        }
    }
}
pub fn send_route(app: &AppHandle, payload: RoutePayload) {
    let state = app.state::<NativeMenu>();
    let ready_route = state.page.lock().unwrap().route(payload);
    if let Some(payload) = ready_route {
        let _ = app.emit_to(
            tauri::EventTarget::webview_window("main"),
            ROUTE_EVENT,
            payload,
        );
    }
}
#[tauri::command]
pub fn menu_set_enabled(
    window: tauri::WebviewWindow,
    app: AppHandle,
    items: Vec<EnabledItem>,
) -> Result<Option<RoutePayload>, String> {
    crate::authorized(&window, &app)?;
    validate_enabled(&items)?;
    let state = app.state::<NativeMenu>();
    for item in items {
        for (id, native) in &state.items {
            if *id == item.id {
                native
                    .set_enabled(item.enabled || item.id == "view.close")
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut enabled = state.enabled.lock().unwrap();
        if item.enabled {
            enabled.insert(item.id);
        } else {
            enabled.remove(&item.id);
        }
    }
    let pending = state.page.lock().unwrap().ready();
    Ok(pending)
}
#[cfg(not(target_os = "macos"))]
pub fn install<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(NativeMenu::<R> {
        items: Vec::new(),
        enabled: Mutex::new(HashSet::new()),
        page: Mutex::new(PageBridge::default()),
    });
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    let mut items = Vec::new();
    for section in ["pacer", "File", "Edit", "View", "Go", "Window", "Help"] {
        let sub = Submenu::new(app, section, true)?;
        if section == "pacer" {
            sub.append(&PredefinedMenuItem::about(app, Some("About pacer"), None)?)?;
        }
        for item in model().into_iter().filter(|item| item.section == section) {
            let native = MenuItem::with_id(
                app,
                item.id,
                item.title,
                item.id.starts_with("native.") || item.id == "view.close",
                item.accelerator,
            )?;
            sub.append(&native)?;
            items.push((item.id, native));
        }
        match section {
            "pacer" => {
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&PredefinedMenuItem::hide(app, None)?)?;
                sub.append(&PredefinedMenuItem::hide_others(app, None)?)?;
                sub.append(&PredefinedMenuItem::show_all(app, None)?)?;
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&PredefinedMenuItem::quit(app, Some("Quit pacer"))?)?;
            }
            "Edit" => {
                sub.append(&PredefinedMenuItem::undo(app, None)?)?;
                sub.append(&PredefinedMenuItem::redo(app, None)?)?;
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&PredefinedMenuItem::cut(app, None)?)?;
                sub.append(&PredefinedMenuItem::copy(app, None)?)?;
                sub.append(&PredefinedMenuItem::paste(app, None)?)?;
                sub.append(&PredefinedMenuItem::select_all(app, None)?)?;
            }
            "View" => {
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&PredefinedMenuItem::fullscreen(
                    app,
                    Some("Enter Full Screen"),
                )?)?;
            }
            "Window" => {
                sub.append(&PredefinedMenuItem::minimize(app, None)?)?;
                sub.append(&PredefinedMenuItem::maximize(app, None)?)?;
                sub.append(&PredefinedMenuItem::bring_all_to_front(app, None)?)?;
                #[cfg(target_os = "macos")]
                sub.set_as_windows_menu_for_nsapp()?;
            }
            "Help" => {
                #[cfg(target_os = "macos")]
                sub.set_as_help_menu_for_nsapp()?;
            }
            _ => {}
        }
        menu.append(&sub)?;
    }
    app.manage(NativeMenu {
        items,
        enabled: Mutex::new(HashSet::new()),
        page: Mutex::new(PageBridge::default()),
    });
    // macOS menus are app-wide; WebviewWindow::set_menu is a no-op there. The bridge
    // only routes commands to the main window, so the tray popover never receives them.
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        match id {
            "native.service-guidance" => crate::show_service_guidance(app),
            "native.docs" => crate::open_external(
                &reqwest::Url::parse("https://github.com/lamtuanvu/pacer/tree/main/docs").unwrap(),
            ),
            "native.issue" => crate::open_external(
                &reqwest::Url::parse("https://github.com/lamtuanvu/pacer/issues").unwrap(),
            ),
            "native.updates" => crate::navigate(app, "#/settings/updates"),
            _ => {
                let state = app.state::<NativeMenu>();
                if !state.items.iter().any(|(known, _)| *known == id) {
                    return;
                }
                let enabled = state.enabled.lock().unwrap().contains(id);
                if let Some(window) = app.get_webview_window("main") {
                    if id == "view.close" && !enabled {
                        let _ = window.hide();
                    } else if enabled {
                        if id != "view.close" {
                            crate::show(app);
                        }
                        let _ = app.emit_to(
                            tauri::EventTarget::webview_window("main"),
                            COMMAND_EVENT,
                            CommandPayload { id: id.into() },
                        );
                    }
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_command_ids_match_typescript_menu_commands() {
        let source = include_str!("../../../app/src/shell/desktop-menu-bridge.ts");
        let array = source
            .split("export const MENU_COMMANDS = [")
            .nth(1)
            .expect("MENU_COMMANDS array")
            .split(']')
            .next()
            .unwrap();
        let ids: Vec<_> = array
            .split(',')
            .map(|id| {
                let id = id.trim();
                assert!(
                    id.starts_with('"') && id.ends_with('"'),
                    "Expected a literal command id: {id}"
                );
                id.trim_matches('"')
            })
            .collect();
        let page: HashSet<_> = ids.iter().copied().collect();
        assert_eq!(page.len(), ids.len(), "Duplicate page command ids");
        let native: HashSet<_> = model()
            .into_iter()
            .filter(|item| !item.id.starts_with("native."))
            .map(|item| item.id)
            .collect();
        assert_eq!(native, page);
    }
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn install_creates_no_menu_items_or_accelerators() {
        use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let windows = ["main", "tray"].map(|label| {
            tauri::WebviewWindowBuilder::new(
                &app,
                label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .build()
            .unwrap()
        });
        assert!(app.menu().is_none());
        assert!(windows.iter().all(|window| window.menu().is_none()));
        install(app.handle()).unwrap();
        assert!(
            app.menu().is_none(),
            "Non-macOS install must not create an app menu"
        );
        assert!(windows.iter().all(|window| window.menu().is_none()));
        let state = app.state::<NativeMenu<MockRuntime>>();
        // Accelerators are installed by MenuItem::with_id; no items means none are installed.
        assert!(state.items.is_empty());
        assert!(state.enabled.lock().unwrap().is_empty());
    }
    #[test]
    fn enabled_ids_reject_unknown_native_and_oversized_reports() {
        let item = |id: &str| EnabledItem {
            id: id.into(),
            enabled: true,
        };
        assert!(validate_enabled(&[item("go.tasks"), item("view.close")]).is_ok());
        for id in ["unknown", "native.docs", "native.updates"] {
            assert!(validate_enabled(&[item(id)]).is_err());
        }
        assert!(validate_enabled(
            &(0..=model().len())
                .map(|_| item("go.tasks"))
                .collect::<Vec<_>>()
        )
        .is_err());
    }
    #[test]
    fn route_waits_for_readiness_and_keeps_answer_query() {
        let mut bridge = PageBridge::default();
        let route = route_payload("#/needs-you?answer=t-20261102-092025-d545").unwrap();
        assert!(bridge.route(route.clone()).is_none());
        assert_eq!(bridge.ready().unwrap().hash, route.hash);
        assert!(bridge.ready().is_none());
        assert!(bridge.route(route.clone()).is_some());
        bridge.started();
        assert!(!bridge.ready);
        assert!(bridge.route(route.clone()).is_none());
        bridge.started();
        assert_eq!(bridge.ready().unwrap().hash, route.hash);
    }
    #[test]
    fn model_uses_registry_ids_and_platform_accelerators() {
        let items = model();
        for (id, accelerator) in [
            ("go.settings", "CmdOrCtrl+,"),
            ("task.new", "CmdOrCtrl+N"),
            ("view.close", "CmdOrCtrl+W"),
            ("go.dispatch", "CmdOrCtrl+1"),
            ("go.needs-you", "CmdOrCtrl+2"),
            ("go.tasks", "CmdOrCtrl+3"),
            ("go.terminal", "CmdOrCtrl+4"),
            ("go.back", "CmdOrCtrl+["),
            ("go.forward", "CmdOrCtrl+]"),
        ] {
            assert!(
                items
                    .iter()
                    .any(|item| item.id == id && item.accelerator == Some(accelerator)),
                "{id}"
            );
        }
        assert_eq!(items.iter().filter(|item| item.section == "Go").count(), 5);
        assert_eq!(
            items
                .iter()
                .filter(|item| item.id.starts_with("view.panel."))
                .count(),
            3
        );
    }
    #[test]
    fn payloads_are_small_and_routes_are_normalized() {
        assert_eq!(
            serde_json::to_value(CommandPayload {
                id: "go.tasks".into()
            })
            .unwrap(),
            serde_json::json!({"id":"go.tasks"})
        );
        assert_eq!(
            serde_json::to_value(route_payload("pacer://tasks").unwrap()).unwrap(),
            serde_json::json!({"hash":"#/tasks"})
        );
        assert!(route_payload("https://example.com").is_none());
    }
}
