//! Typed page-origin-authorized controls; no arbitrary IPC, script or command execution.
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum Action {
    Window { action: WindowAction },
    Tray { action: TrayAction },
    LaunchAtLogin { enabled: bool },
    Quit {},
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WindowAction {
    Show,
    Minimize,
    ToggleMaximize,
    Close,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TrayAction {
    Show,
    Hide,
}

#[tauri::command]
pub(crate) fn client_control(
    window: WebviewWindow,
    app: AppHandle,
    action: Action,
) -> Result<(), String> {
    match window.label() {
        "main" => super::authorized(&window, &app)?,
        "tray" => super::authorized_tray(&window, &app)?,
        _ => return Err("Unknown client window".into()),
    }
    match action {
        Action::Window { action } => {
            let main = app
                .get_webview_window("main")
                .ok_or("Main window unavailable")?;
            match action {
                WindowAction::Show => {
                    main.show().map_err(|e| e.to_string())?;
                    main.set_focus().map_err(|e| e.to_string())?;
                }
                WindowAction::Minimize => main.minimize().map_err(|e| e.to_string())?,
                WindowAction::ToggleMaximize => {
                    if main.is_maximized().map_err(|e| e.to_string())? {
                        main.unmaximize()
                    } else {
                        main.maximize()
                    }
                    .map_err(|e| e.to_string())?;
                }
                WindowAction::Close => main.hide().map_err(|e| e.to_string())?,
            }
        }
        Action::Tray { action } => {
            let tray = app.get_webview_window("tray").ok_or("Tray unavailable")?;
            match action {
                TrayAction::Hide => tray.hide().map_err(|e| e.to_string())?,
                TrayAction::Show => {
                    super::position_tray(&tray).map_err(|e| e.to_string())?;
                    tray.show().map_err(|e| e.to_string())?;
                    tray.set_focus().map_err(|e| e.to_string())?;
                }
            }
        }
        Action::LaunchAtLogin { enabled } => super::launch_at_login(&app, enabled)?,
        // A process exit may prevent acknowledgment: callers must observe the request timeout.
        Action::Quit {} => app.exit(0),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_typed_actions_deserialize() {
        assert!(serde_json::from_str::<Action>(r#"{"type":"window","action":"minimize"}"#).is_ok());
        assert!(serde_json::from_str::<Action>(r#"{"type":"window","action":"eval"}"#).is_err());
        assert!(serde_json::from_str::<Action>(r#"{"type":"quit","script":"bad"}"#).is_err());
    }
}
