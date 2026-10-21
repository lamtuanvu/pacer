//! Owned-window diagnostics available in ordinary release builds.
use std::time::Duration;
use tauri::{AppHandle, Manager};
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub enum CaptureMode {
    Window,
    Content,
}
pub struct CapturedImage {
    pub png: Vec<u8>,
    pub scale: f64,
}
pub fn validate_request(label: &str, mode: &str) -> Result<CaptureMode, &'static str> {
    if !matches!(label, "main" | "tray") {
        return Err("window_unavailable");
    }
    match mode {
        "window" => Ok(CaptureMode::Window),
        "content" => Ok(CaptureMode::Content),
        _ => Err("capture_failed"),
    }
}
pub fn validate_image(bytes: &[u8]) -> Result<(u32, u32), &'static str> {
    if bytes.len() < 24
        || bytes.len() > 16 * 1024 * 1024
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || &bytes[12..16] != b"IHDR"
    {
        return Err("capture_failed");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err("capture_failed");
    }
    Ok((width, height))
}
pub async fn capture_owned_window(
    app: &AppHandle,
    label: &str,
    mode: &str,
    origin: &str,
) -> Result<CapturedImage, &'static str> {
    let mode = validate_request(label, mode)?;
    let window = app.get_webview_window(label).ok_or("window_unavailable")?;
    let url = window.url().map_err(|_| "window_unavailable")?;
    if crate::logic::local_origin(&url).as_deref() != Some(origin)
        || !url.path().starts_with("/app/")
        || url.path() == "/app/auth"
    {
        return Err("window_unavailable");
    }
    #[cfg(target_os = "macos")]
    {
        tokio::time::timeout(Duration::from_secs(10), macos::capture(window, mode))
            .await
            .map_err(|_| "capture_timeout")?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, mode, Duration::from_secs(10));
        Err("unsupported_platform")
    }
}
/// This worker lives inside the existing authenticated desktop session. No new listener.
pub async fn worker(
    app: &AppHandle,
    session: &crate::client::Session,
    client_id: &str,
    token: &str,
) -> Result<(), String> {
    loop {
        let windows = owned_targets(app).await;
        let request = session
            .op(
                "desktop.capture.claim",
                &serde_json::json!({"client_id":client_id,"worker_token":token,"windows":windows}),
            )
            .await?;
        if let Some(id) = request["request_id"].as_str() {
            let label = request["window"].as_str().unwrap_or("");
            let mode = request["mode"].as_str().unwrap_or("");
            match capture_owned_window(app, label, mode, &session.origin).await {
                Ok(image) => {
                    let response = session
                        .client
                        .post(format!("{}/v3/desktop/capture/{id}/image", session.origin))
                        .header("Origin", &session.origin)
                        .header("X-Pacer-Client", "app")
                        .header("X-Pacer-Capture-Worker", token)
                        .header("X-Pacer-Capture-Method", mode)
                        .header("X-Pacer-Capture-Scale", image.scale.to_string())
                        .header("Content-Type", "image/png")
                        .body(image.png)
                        .timeout(Duration::from_secs(15))
                        .send()
                        .await
                        .map_err(|_| "Capture upload failed")?;
                    if !response.status().is_success() {
                        return Err("Capture upload rejected".into());
                    }
                }
                Err(error) => {
                    session.op("desktop.capture.complete", &serde_json::json!({"request_id":id,"worker_token":token,"error":error})).await?;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn owned_targets(app: &AppHandle) -> Vec<serde_json::Value> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    if app.run_on_main_thread(move || {
        let mut targets = Vec::new();
        for label in ["main", "tray"] {
            if let Some(window) = handle.get_webview_window(label) {
                #[cfg(target_os = "macos")]
                if let Ok(pointer) = window.ns_window() {
                    let number: isize = unsafe { objc2::msg_send![pointer as *mut objc2::runtime::AnyObject, windowNumber] };
                    targets.push(serde_json::json!({"label":label,"window_id":number.to_string(),"pid":std::process::id()}));
                }
            }
        }
        let _ = sender.send(targets);
    }).is_err() { return Vec::new(); }
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}
