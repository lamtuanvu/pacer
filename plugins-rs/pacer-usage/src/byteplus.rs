//! BytePlus (arkcli) coding-plan quota reader, port of
//! `plugins/pacer-usage/byteplus.ts`. Subprocess-backed (readable via the
//! host's `process.spawn` capability only).

use super::{Availability, AvailabilityState, ReaderContext, UsageReading, UsageSource, UsageWindow};
use crate::util::{is_obj, parse_ts, to_num};
use pacer_plugin::PluginError;
use serde_json::Value;

const KEY: &str = "arkcli-usage-plan";
const TTL_S: f64 = 600.0;
const MAX_STALE_S: f64 = 6.0 * 3600.0;
const TIMEOUT_MS: u64 = 8000;
const ARGV: &[&str] = &["arkcli", "usage", "plan", "--product", "coding-plan"];

/// Same wall-clock instant one calendar month earlier (UTC), clamped to the
/// month's end (byteplus.ts:8-13). Uses jiff month subtraction, which clamps
/// (Mar 31 → Feb 28), matching the TS `setUTCMonth` + `setUTCDate(0)`.
pub fn month_before(ts: f64) -> f64 {
    let seconds = ts.floor() as i64;
    let Ok(t) = jiff::Timestamp::from_second(seconds) else {
        return ts;
    };
    let z = t.to_zoned(jiff::tz::TimeZone::UTC);
    let dt = z.datetime();
    let Ok(prev) = dt.checked_sub(jiff::Span::new().months(1)) else {
        return ts;
    };
    let Ok(prev_ts) = prev.to_zoned(jiff::tz::TimeZone::UTC) else {
        return ts;
    };
    prev_ts.timestamp().as_second() as f64
}

fn valid_until(captured_at: Option<f64>) -> Option<f64> {
    captured_at.map(|c| c + 600.0)
}

async fn fetch_plan(io: &dyn pacer_plugin::usage::ReaderIo) -> Result<Value, PluginError> {
    let result = io.run(ARGV, TIMEOUT_MS).await?;
    if result.code != 0 {
        let msg = format!(
            "arkcli exited {}: {}",
            result.code,
            result.stderr.trim().chars().take(200).collect::<String>()
        );
        return Err(PluginError::new("command", msg));
    }
    serde_json::from_str(&result.stdout).map_err(|e| PluginError::new("command", e.to_string()))
}

/// `readByteplus` (byteplus.ts:15-54): arkcli coding-plan availability and
/// windows, cached by the host.
pub async fn read_byteplus(ctx: &ReaderContext<'_>, refresh: bool) -> UsageReading {
    let io = ctx.io;
    let c = io
        .cached_fetch(
            KEY,
            TTL_S,
            MAX_STALE_S,
            Box::pin(fetch_plan(io)),
            refresh,
            ctx.now,
            ctx.read_only,
        )
        .await;
    let c = match c {
        Ok(c) => c,
        Err(_) => {
            return UsageReading {
                windows: Vec::new(),
                captured_at: None,
                stale: false,
                error: Some("plugin offline".to_owned()),
                ..Default::default()
            };
        }
    };
    if c.value.is_none() {
        return UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: false,
            error: c.error,
            ..Default::default()
        };
    }
    let value = c.value.clone().unwrap_or(Value::Null);
    let items = if is_obj(&value) && value.get("items").and_then(Value::as_array).is_some() {
        value.get("items").and_then(Value::as_array).cloned()
    } else {
        None
    };
    let Some(items) = items else {
        return UsageReading {
            windows: Vec::new(),
            captured_at: c.captured_at,
            stale: c.stale,
            source: Some(UsageSource::ProviderCli),
            availability: Some(Availability {
                state: AvailabilityState::Unknown,
                reason: "subscription_response_invalid".to_owned(),
                valid_until: valid_until(c.captured_at),
            }),
            error: Some("invalid coding-plan subscription response".to_owned()),
            ..Default::default()
        };
    };
    let item = items
        .iter()
        .find(|i| is_obj(i) && i.get("product").and_then(Value::as_str) == Some("coding-plan") && i.get("subscribed").and_then(Value::as_bool) == Some(true));
    let Some(item) = item else {
        let failed = items.iter().find(|i| {
            is_obj(i)
                && i.get("product").and_then(Value::as_str) == Some("coding-plan")
                && i.get("error").and_then(Value::as_str).is_some()
        });
        if let Some(failed) = failed {
            let text = failed.get("error").and_then(Value::as_str).unwrap_or("");
            let auth = auth_re().is_match(text);
            return UsageReading {
                windows: Vec::new(),
                captured_at: c.captured_at,
                stale: c.stale,
                source: Some(UsageSource::ProviderCli),
                availability: Some(Availability {
                    state: AvailabilityState::Unknown,
                    reason: if auth {
                        "authentication_failed".to_owned()
                    } else {
                        "subscription_failed".to_owned()
                    },
                    valid_until: valid_until(c.captured_at),
                }),
                error: Some(if auth {
                    "Ark CLI sign-in required. Run arkcli auth login.".to_owned()
                } else {
                    "Could not read coding-plan subscription.".to_owned()
                }),
                ..Default::default()
            };
        }
        let explicit = items.is_empty()
            || items.iter().any(|i| {
                is_obj(i)
                    && i.get("product").and_then(Value::as_str) == Some("coding-plan")
                    && i.get("subscribed").and_then(Value::as_bool) == Some(false)
            });
        return UsageReading {
            windows: Vec::new(),
            captured_at: c.captured_at,
            stale: c.stale,
            source: Some(UsageSource::ProviderCli),
            availability: Some(Availability {
                state: if explicit && !c.stale {
                    AvailabilityState::Unavailable
                } else {
                    AvailabilityState::Unknown
                },
                reason: if explicit {
                    "subscription_missing".to_owned()
                } else {
                    "subscription_response_invalid".to_owned()
                },
                valid_until: valid_until(c.captured_at),
            }),
            error: Some(c.error.unwrap_or_else(|| "no active coding-plan subscription".to_owned())),
            ..Default::default()
        };
    };
    let mut windows = Vec::new();
    if let Some(periods) = item.get("periods").and_then(Value::as_array) {
        for per in periods {
            if !is_obj(per) {
                continue;
            }
            let used_pct = to_num(per.get("percent").unwrap_or(&Value::Null));
            let resets_at = parse_ts(per.get("reset_at").unwrap_or(&Value::Null));
            match per.get("label").and_then(Value::as_str) {
                Some("session") => windows.push(UsageWindow {
                    name: "5h".to_owned(),
                    used_pct,
                    resets_at,
                    length_s: 5.0 * 3600.0,
                    paced: false,
                    stale: None,
                }),
                Some("weekly") => windows.push(UsageWindow {
                    name: "weekly".to_owned(),
                    used_pct,
                    resets_at,
                    length_s: 7.0 * 86400.0,
                    paced: true,
                    stale: None,
                }),
                Some("monthly") => {
                    let length_s = resets_at
                        .map(|r| r - month_before(r))
                        .unwrap_or(30.0 * 86400.0);
                    windows.push(UsageWindow {
                        name: "monthly".to_owned(),
                        used_pct,
                        resets_at,
                        length_s,
                        paced: true,
                        stale: None,
                    });
                }
                _ => {}
            }
        }
    }
    UsageReading {
        windows,
        captured_at: c.captured_at,
        stale: c.stale,
        error: c.error,
        source: Some(UsageSource::ProviderCli),
        availability: Some(Availability {
            state: if c.stale {
                AvailabilityState::Unknown
            } else {
                AvailabilityState::Ready
            },
            reason: "subscription_active".to_owned(),
            valid_until: valid_until(c.captured_at),
        }),
        ..Default::default()
    }
}

use std::sync::OnceLock;
fn auth_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?:auth login|sso sts|refresh_token|authentication|unauthori[sz]ed)")
            .unwrap_or_else(|e| panic!("auth regex must be valid: {e}"))
    })
}