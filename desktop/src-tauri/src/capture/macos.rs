use super::{validate_image, CaptureMode, CapturedImage, SystemTime, UNIX_EPOCH};
use block2::RcBlock;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_core_graphics::CGImage;
use std::sync::{Arc, Mutex};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}
type Sender = Arc<Mutex<Option<oneshot::Sender<Result<Vec<u8>, &'static str>>>>>;
fn finish(sender: &Sender, value: Result<Vec<u8>, &'static str>) {
    if let Ok(mut guard) = sender.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(value);
        }
    }
}
unsafe fn class(name: &'static std::ffi::CStr) -> Result<&'static AnyClass, &'static str> {
    AnyClass::get(name).ok_or("unsupported_platform")
}
unsafe fn png_from_rep(rep: *mut AnyObject) -> Result<Vec<u8>, &'static str> {
    if rep.is_null() {
        return Err("capture_failed");
    }
    let dictionary: *mut AnyObject = msg_send![class(c"NSDictionary")?, dictionary];
    let data: *mut AnyObject =
        msg_send![rep, representationUsingType: 4usize, properties: dictionary];
    if data.is_null() {
        return Err("capture_failed");
    }
    let length: usize = msg_send![data, length];
    if length == 0 || length > 16 * 1024 * 1024 {
        return Err("capture_failed");
    }
    let bytes: *const u8 = msg_send![data, bytes];
    if bytes.is_null() {
        return Err("capture_failed");
    }
    Ok(std::slice::from_raw_parts(bytes, length).to_vec())
}
unsafe fn png_from_image(image: *mut AnyObject) -> Result<Vec<u8>, &'static str> {
    if image.is_null() {
        return Err("capture_failed");
    }
    let data: *mut AnyObject = msg_send![image, TIFFRepresentation];
    if data.is_null() {
        return Err("capture_failed");
    }
    let rep: *mut AnyObject = msg_send![class(c"NSBitmapImageRep")?, imageRepWithData: data];
    png_from_rep(rep)
}
pub async fn capture(
    window: WebviewWindow,
    mode: CaptureMode,
) -> Result<CapturedImage, &'static str> {
    let scale = window.scale_factor().map_err(|_| "window_unavailable")?;
    let size = window.outer_size().map_err(|_| "window_unavailable")?;
    if size.width > 16384 || size.height > 16384 {
        return Err("capture_failed");
    }
    let window_identity = Arc::new(Mutex::new(None::<String>));
    let captured_identity = window_identity.clone();
    let (tx, rx) = oneshot::channel();
    let sender: Sender = Arc::new(Mutex::new(Some(tx)));
    match mode {
        CaptureMode::Content => {
            window.with_webview(move |webview| unsafe {
                let number: isize = msg_send![webview.ns_window() as *mut AnyObject, windowNumber];
                *captured_identity.lock().unwrap() = Some(number.to_string());
                let block_sender = sender.clone();
                let completion = RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
                    finish(&block_sender, if error.is_null() { png_from_image(image) } else { Err("capture_failed") });
                });
                let inner = webview.inner() as *mut AnyObject;
                let _: () = msg_send![inner, takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(), completionHandler: &*completion];
            }).map_err(|_| "window_unavailable")?;
        }
        CaptureMode::Window => {
            if !unsafe { CGPreflightScreenCaptureAccess() } {
                return Err("permission_denied");
            }
            let main = window.clone();
            window.run_on_main_thread(move || unsafe {
                let result = (|| -> Result<(), &'static str> {
                    let ns_window = main.ns_window().map_err(|_| "window_unavailable")? as *mut AnyObject;
                    let number: isize = msg_send![ns_window, windowNumber];
                    *captured_identity.lock().unwrap() = Some(number.to_string());
                    let manager = class(c"SCScreenshotManager")?;
                    let shareable = class(c"SCShareableContent")?;
                    let outer_sender = sender.clone();
                    let completion = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
                        if !error.is_null() || content.is_null() { finish(&outer_sender, Err("capture_failed")); return; }
                        let result = (|| -> Result<(), &'static str> {
                            let windows: *mut AnyObject = msg_send![content, windows];
                            let count: usize = msg_send![windows, count];
                            let mut chosen = std::ptr::null_mut::<AnyObject>();
                            for index in 0..count {
                                let candidate: *mut AnyObject = msg_send![windows, objectAtIndex: index];
                                let id: u32 = msg_send![candidate, windowID];
                                if id as isize == number { chosen = candidate; break; }
                            }
                            if chosen.is_null() { return Err("window_unavailable"); }
                            let allocated: *mut AnyObject = msg_send![class(c"SCContentFilter")?, alloc];
                            let filter: *mut AnyObject = msg_send![allocated, initWithDesktopIndependentWindow: chosen];
                            let filter = Retained::from_raw(filter).ok_or("capture_failed")?;
                            let configuration: *mut AnyObject = msg_send![class(c"SCStreamConfiguration")?, new];
                            let configuration = Retained::from_raw(configuration).ok_or("capture_failed")?;
                            let _: () = msg_send![&*configuration, setWidth: size.width as usize];
                            let _: () = msg_send![&*configuration, setHeight: size.height as usize];
                            let _: () = msg_send![&*configuration, setShowsCursor: Bool::NO];
                            let image_sender = outer_sender.clone();
                            let image_completion = RcBlock::new(move |image: *mut CGImage, error: *mut AnyObject| {
                                let bytes = (|| -> Result<Vec<u8>, &'static str> {
                                    if !error.is_null() || image.is_null() { return Err("capture_failed"); }
                                    let allocated: *mut AnyObject = msg_send![class(c"NSBitmapImageRep")?, alloc];
                                    let rep: *mut AnyObject = msg_send![allocated, initWithCGImage: image];
                                    let rep = Retained::from_raw(rep).ok_or("capture_failed")?;
                                    png_from_rep(&*rep as *const AnyObject as *mut AnyObject)
                                })();
                                finish(&image_sender, bytes);
                            });
                            let _: () = msg_send![manager, captureImageWithFilter: &*filter, configuration: &*configuration, completionHandler: &*image_completion];
                            Ok(())
                        })();
                        if let Err(error) = result { finish(&outer_sender, Err(error)); }
                    });
                    let _: () = msg_send![shareable, getShareableContentExcludingDesktopWindows: Bool::YES, onScreenWindowsOnly: Bool::YES, completionHandler: &*completion];
                    Ok(())
                })();
                if let Err(error) = result { finish(&sender, Err(error)); }
            }).map_err(|_| "window_unavailable")?;
        }
    }
    let png = rx.await.map_err(|_| "capture_failed")??;
    let (width, _) = validate_image(&png)?;
    let inner = window.inner_size().map_err(|_| "window_unavailable")?;
    let viewport_width = inner.width as f64 / scale;
    let viewport_height = inner.height as f64 / scale;
    let point_width = match mode {
        CaptureMode::Content => viewport_width,
        CaptureMode::Window => size.width as f64 / scale,
    };
    let scale = width as f64 / point_width;
    let window_id = window_identity
        .lock()
        .map_err(|_| "capture_failed")?
        .clone()
        .ok_or("capture_failed")?;
    let captured_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "capture_failed")?
        .as_millis() as u64;
    Ok(CapturedImage {
        png,
        scale,
        window_id,
        captured_at_ms,
        viewport_width,
        viewport_height,
    })
}
