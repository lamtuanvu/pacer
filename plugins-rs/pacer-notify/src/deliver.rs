//! Implements `notifier.deliver`: hand a notification to the host's chosen
//! platform tool. Port of `plugins/pacer-notify/index.ts`.

use pacer_plugin::{Ctx, HandlerResult, PluginError, js};
use serde_json::{Map, Value, json};

/// Max UTF-16 length of `title`, matching `z.string().max(256)`.
const TITLE_MAX: usize = 256;
/// Max UTF-16 length of `body`, matching `z.string().max(2048)`.
const BODY_MAX: usize = 2048;
/// Spawn timeout in milliseconds, matching `timeoutMs: 5000`.
const TIMEOUT_MS: u64 = 5000;

/// A parsed and validated notification payload.
struct Notification<'a> {
    title: &'a str,
    body: &'a str,
}

/// Validate the notification params, matching the TS `notification` zod schema:
/// `key` and `url` must be strings and `title`/`body` are length-limited by
/// UTF-16 code units (the string's ECMAScript length). Returns `None` when the
/// shape is invalid without consuming/dropping anything.
fn parse_notification(params: &Value) -> Option<Notification<'_>> {
    let obj = params.as_object()?;
    let title = obj.get("title")?.as_str()?;
    let body = obj.get("body")?.as_str()?;
    if obj.get("key")?.is_string()
        && obj.get("url")?.is_string()
        && js::utf16_len(title) <= TITLE_MAX
        && js::utf16_len(body) <= BODY_MAX
    {
        Some(Notification { title, body })
    } else {
        None
    }
}

/// The literal argv for the host's platform, mirroring the TS branches. No
/// `which`, `PATH` or config binary lookup; the host pins the executable.
pub fn argv<'a>(platform: &str, title: &'a str, body: &'a str) -> Option<Vec<&'a str>> {
    match platform {
        "darwin" => Some(vec![
            "osascript",
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            title,
            body,
        ]),
        "linux" => Some(vec!["notify-send", "--", title, body]),
        _ => None,
    }
}

/// The host's chosen platform, or `None` when the config has no (string)
/// `platform`; mirrors the TS `configuration` schema where platform is
/// optional and any non-darwin/linux value means "don't deliver".
fn platform(config: &Map<String, Value>) -> Option<&str> {
    config.get("platform").and_then(Value::as_str)
}

/// Handle `notifier.deliver`.
pub async fn deliver(params: Value, ctx: Ctx) -> HandlerResult {
    let parsed = match parse_notification(&params) {
        Some(parsed) => parsed,
        None => return Err(PluginError::new("invalid_input", "invalid notifier input")),
    };
    if ctx.cancel.is_cancelled() {
        return Ok(json!({ "delivered": false }));
    }
    let result: HandlerResult = async {
        // Only the host chooses platform and pins the fixed command's executable.
        let config = ctx.host.config().await?;
        if ctx.cancel.is_cancelled() {
            return Ok(json!({ "delivered": false }));
        }
        let Some(platform) = platform(&config) else {
            return Ok(json!({ "delivered": false }));
        };
        let Some(argv) = argv(platform, parsed.title, parsed.body) else {
            return Ok(json!({ "delivered": false }));
        };
        let result = ctx
            .host
            .call(
                "capability.process.spawn",
                json!({ "argv": argv, "timeoutMs": TIMEOUT_MS }),
            )
            .await?;
        let code = result.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let timed_out = result
            .get("timedOut")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(json!({
            "delivered": !ctx.cancel.is_cancelled() && code == 0 && !timed_out
        }))
    }
    .await;
    match result {
        Ok(reply) => Ok(reply),
        Err(_) => {
            // Delivery failure must not fail the pump; log a safe fixed warning.
            if ctx
                .host
                .log("warn", "OS notification delivery failed")
                .await
                .is_err()
            {
                // Warning failure does not change the outcome.
            }
            Ok(json!({ "delivered": false }))
        }
    }
}
