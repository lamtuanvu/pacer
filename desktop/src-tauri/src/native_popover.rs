//! macOS tray presentation. AppKit objects remain on the main thread.
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSRect, NSSize};
use std::cell::RefCell;
use tauri::{AppHandle, WebviewWindow};

thread_local! {
    static HEIGHT: RefCell<f64> = const { RefCell::new(120.0) };
    static POPOVER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

// All AppKit access is dispatched by Tauri's main-thread webview callback. The
// retained popover owns its controller and the controller retains the webview;
// Tauri retains the original window and remains responsible for its lifetime.
async fn dispatch(
    window: &WebviewWindow,
    action: impl FnOnce(*mut AnyObject) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    acknowledge(|complete| {
        window.with_webview(move |view| complete(view.inner().cast()))
            .map_err(|e| e.to_string())
    }, action).await
}

async fn acknowledge<T: 'static>(
    schedule: impl FnOnce(Box<dyn FnOnce(T) + Send>) -> Result<(), String>,
    action: impl FnOnce(T) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    schedule(Box::new(move |value| { let _ = sender.send(action(value)); }))?;
    receiver.await.map_err(|_| "Native tray action cancelled".to_string())?
}

fn require_button(button: *mut AnyObject) -> Result<*mut AnyObject, String> {
    if button.is_null() { Err("Status button unavailable".into()) } else { Ok(button) }

}

pub async fn show(app: &AppHandle, window: &WebviewWindow, toggle: bool) -> Result<(), String> {
    let tray = app.tray_by_id("pacer").ok_or("Tray icon unavailable")?;
    // Get the status item only inside Tauri's main-thread callback; pass it to
    // the webview callback as an opaque address, never dereference off-thread.
    let item = tray
        .with_inner_tray_icon(|inner| {
            inner
                .ns_status_item()
                .map(|item| Retained::as_ptr(&item) as usize)
        })
        .map_err(|e| e.to_string())?
        .ok_or("Status item unavailable")?;
    dispatch(window, move |web| unsafe {
        // Keep the tray owner alive until the borrowed status-item pointer is used.
        let _tray_owner = tray;
        POPOVER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let pop = slot.get_or_insert_with(|| {
                let controller: Retained<AnyObject> = msg_send![class!(NSViewController), new];
                let _: () = msg_send![&*controller, setView: web];
                let pop: Retained<AnyObject> = msg_send![class!(NSPopover), new];
                let _: () = msg_send![&*pop, setContentViewController: &*controller];
                let _: () = msg_send![&*pop, setBehavior: 1isize]; // transient
                let _: () = msg_send![&*pop, setContentSize: NSSize::new(super::TRAY_WIDTH, HEIGHT.with(|h| *h.borrow()))];
                pop
            });
            let shown: bool = msg_send![&**pop, isShown];
            if shown && toggle {
                let _: () = msg_send![&**pop, performClose: std::ptr::null::<AnyObject>()];
            } else if !shown {
                let button: *mut AnyObject = msg_send![item as *mut AnyObject, button];
                let button = require_button(button)?;
                {
                    let bounds: NSRect = msg_send![button, bounds];
                    let _: () = msg_send![&**pop, showRelativeToRect: bounds, ofView: button, preferredEdge: 1usize];
                    let shown: bool = msg_send![&**pop, isShown];
                    if !shown { return Err("Unable to show tray popover".into()); }
                    let _: bool = msg_send![web, becomeFirstResponder];
                }
            }
            Ok(())
        })
    }).await
}

pub async fn hide(window: &WebviewWindow) -> Result<(), String> {
    dispatch(window, |_| unsafe {
        POPOVER.with(|slot| {
            if let Some(pop) = slot.borrow().as_ref() {
                let _: () = msg_send![&**pop, performClose: std::ptr::null::<AnyObject>()];
            }
        });
        Ok(())
    }).await
}

pub async fn resize(window: &WebviewWindow, height: f64) -> Result<(), String> {
    dispatch(window, move |_| unsafe {
        HEIGHT.with(|h| *h.borrow_mut() = height);
        POPOVER.with(|slot| {
            if let Some(pop) = slot.borrow().as_ref() {
                let _: () =
                    msg_send![&**pop, setContentSize: NSSize::new(super::TRAY_WIDTH, height)];
            }
        });
        Ok(())
    }).await
}

// Called on the AppKit main thread. Only advertise an actually shown popover.
pub(crate) fn window_number() -> Option<isize> {
    POPOVER.with(|slot| unsafe {
        let slot = slot.borrow();
        let pop = slot.as_ref()?;
        let shown: bool = msg_send![&**pop, isShown];
        if !shown { return None; }
        let controller: *mut AnyObject = msg_send![&**pop, contentViewController];
        let view: *mut AnyObject = msg_send![controller, view];
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() { return None; }
        let number: isize = msg_send![window, windowNumber];
        (number > 0).then_some(number)
    })
}

pub(crate) fn shutdown() {
    POPOVER.with(|slot| unsafe {
        if let Some(pop) = slot.borrow_mut().take() {
            let _: () = msg_send![&*pop, close];
            let controller: *mut AnyObject = msg_send![&*pop, contentViewController];
            let _: () = msg_send![controller, setView: std::ptr::null::<AnyObject>()];
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn acknowledgement_waits_and_propagates_native_failure() {
        let (tx, rx) = std::sync::mpsc::channel();
        let task = tokio::spawn(acknowledge(move |callback: Box<dyn FnOnce(()) + Send>| {
            tx.send(callback).unwrap();
            Ok(())
        }, |_| Err("native failure".into())));
        let callback = rx.recv().unwrap();
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        callback(());
        assert_eq!(task.await.unwrap(), Err("native failure".into()));
    }

    #[test]
    fn missing_status_button_is_an_error() {
        assert_eq!(require_button(std::ptr::null_mut()).unwrap_err(), "Status button unavailable");
    }
}
