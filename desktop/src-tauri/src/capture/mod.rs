//! Owned-window diagnostics available in ordinary release builds.
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    pub window_id: String,
    pub captured_at_ms: u64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}
static BUILD_HASH: OnceLock<String> = OnceLock::new();
pub fn initialize_build_identity() {
    BUILD_HASH.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| std::fs::read(path).ok())
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .unwrap_or_default()
    });
}
fn metadata(image: &CapturedImage, method: &str) -> serde_json::Value {
    serde_json::json!({"method":method,"scale":image.scale,"window_id":image.window_id,"pid":std::process::id(),
        "app_version":env!("CARGO_PKG_VERSION"),"app_sha256":BUILD_HASH.get().cloned().unwrap_or_default(),
        "captured_at_ms":image.captured_at_ms,"viewport_width":image.viewport_width,"viewport_height":image.viewport_height})
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
    let decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: 128 * 1024 * 1024,
        },
    );
    let mut reader = decoder.read_info().map_err(|_| "capture_failed")?;
    let width = reader.info().width;
    let height = reader.info().height;
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err("capture_failed");
    }
    let size = reader.output_buffer_size().ok_or("capture_failed")?;
    if size > 128 * 1024 * 1024 {
        return Err("capture_failed");
    }
    let mut output = vec![0; size];
    reader
        .next_frame(&mut output)
        .map_err(|_| "capture_failed")?;
    reader.finish().map_err(|_| "capture_failed")?;
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
    let mut credential = token.to_owned();
    let mut delay = 1;
    loop {
        let windows = owned_targets(app).await;
        let request = match claim_next(session, client_id, &mut credential, windows).await {
            Ok(request) => {
                delay = 1;
                request
            }
            Err(_) => {
                desktop_log!("Desktop capture observer reconnecting");
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(10);
                continue;
            }
        };
        if let Some(id) = request["request_id"].as_str() {
            let label = request["window"].as_str().unwrap_or("");
            let mode = request["mode"].as_str().unwrap_or("");
            let outcome = match capture_owned_window(app, label, mode, &session.origin).await {
                Ok(image)
                    if request["window_id"]
                        .as_str()
                        .is_none_or(|expected| expected == image.window_id) =>
                {
                    let capture_metadata = metadata(&image, mode).to_string();
                    session
                        .client
                        .post(format!("{}/v3/desktop/capture/{id}/image", session.origin))
                        .header("Origin", &session.origin)
                        .header("X-Pacer-Client", "app")
                        .header("X-Pacer-Capture-Worker", &credential)
                        .header("X-Pacer-Capture-Method", mode)
                        .header("X-Pacer-Capture-Scale", image.scale.to_string())
                        .header("X-Pacer-Capture-Metadata", capture_metadata)
                        .header("Content-Type", "image/png")
                        .body(image.png)
                        .timeout(Duration::from_secs(10))
                        .send()
                        .await
                        .map(|response| response.status().is_success())
                        .unwrap_or(false)
                }
                Ok(_) => false,
                Err(error) => {
                    let _ = session.op("desktop.capture.complete", &serde_json::json!({"request_id":id,"worker_token":credential,"error":error})).await;
                    false
                }
            };
            if !outcome {
                // Capture is read-only. Preserve failed evidence; never restart a UI action.
                let _ = session.op("desktop.capture.complete", &serde_json::json!({"request_id":id,"worker_token":credential,"error":"capture_failed"})).await;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn claim_next(
    session: &crate::client::Session,
    client_id: &str,
    credential: &mut String,
    windows: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let params = |token: &str| serde_json::json!({"client_id":client_id,"worker_token":token,"windows":windows});
    match session
        .op("desktop.capture.claim", &params(credential))
        .await
    {
        Ok(request) => Ok(request),
        Err(_) => {
            let registration = session
                .op(
                    "desktop.capture.register",
                    &serde_json::json!({"client_id":client_id,"worker_token":credential}),
                )
                .await?;
            *credential = registration["worker_token"]
                .as_str()
                .ok_or("Missing capture worker credential")?
                .to_owned();
            session
                .op("desktop.capture.claim", &params(credential))
                .await
        }
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
