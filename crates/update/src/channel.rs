//! Update channel selection, check enablement and version precedence.
//!
//! These are the small pure checks from `src/update/check.ts` and
//! `src/update/channel.ts` that the desktop update policy reuses (`policy.ts`
//! aliases `updateChecksEnabled` and reads the update cache window). Moved here
//! from `check.rs` so `pacer-desktop-update` (layer 7) can depend on
//! `pacer-update` (layer 6) without a cycle.
use crate::{feed::Channel, js};
use pacer_foundation::{Ctx, js_semantics::js_trim};
use std::fs;

/// The desktop update check cache window, in Unix seconds
/// (`UPDATE_CACHE_S` in `src/update/check.ts`). `checkDue` in the desktop
/// policy uses this exact boundary.
pub const UPDATE_CACHE_S: u64 = 86_400;

/// `activeStrategyText`: the named active strategy, else `strategy.yaml`; `None` when unreadable.
fn strategy_text(ctx: &Ctx) -> Option<String> {
    let active = fs::read_to_string(ctx.pacer_home.join("active"))
        .map(|text| js_trim(&text).to_owned())
        .unwrap_or_default();
    let named = !active.is_empty()
        && active
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let path = if named {
        ctx.pacer_home
            .join("strategies")
            .join(format!("{active}.yaml"))
    } else {
        ctx.pacer_home.join("strategy.yaml")
    };
    fs::read(&path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `updateChecksEnabled`: the env opt-out, then a top-level `update_check: false` in the active strategy text.
pub fn checks_enabled(ctx: &Ctx) -> bool {
    if ctx.env.get("PACER_NO_UPDATE_CHECK").map(String::as_str) == Some("1") {
        return false;
    }
    strategy_text(ctx).is_none_or(|text| !update_check_false(&text))
}

/// `updateChannel`: nightly only for a top-level `update_channel: nightly` (plain or quoted).
pub fn update_channel(ctx: &Ctx) -> Channel {
    if strategy_text(ctx).is_some_and(|text| update_channel_nightly(&text)) {
        Channel::Nightly
    } else {
        Channel::Stable
    }
}

/// `/^update_channel:[ \t]*(["']?)nightly\1[ \t]*(?:#.*)?$/m`.
pub(crate) fn update_channel_nightly(text: &str) -> bool {
    let blank = |c: char| c == ' ' || c == '\t';
    text.split(js::line_end).any(|line| {
        let Some(rest) = line.strip_prefix("update_channel:") else {
            return false;
        };
        let rest = rest.trim_start_matches(blank);
        ["nightly", "\"nightly\"", "'nightly'"].iter().any(|value| {
            rest.strip_prefix(value).is_some_and(|tail| {
                let tail = tail.trim_start_matches(blank);
                tail.is_empty() || tail.starts_with('#')
            })
        })
    })
}

/// `/^update_check:\s*false\s*(?:#.*)?$/m`.
pub(crate) fn update_check_false(text: &str) -> bool {
    let mut start = true;
    for (at, c) in text.char_indices() {
        if start && text[at..].starts_with("update_check:") {
            let rest = text[at + "update_check:".len()..].trim_start_matches(js::space);
            if let Some(after) = rest.strip_prefix("false") {
                let tail = after.trim_start_matches(js::space);
                let run = &after[..after.len() - tail.len()];
                if tail.is_empty() || tail.starts_with('#') || run.contains(js::line_end) {
                    return true;
                }
            }
        }
        start = js::line_end(c);
    }
    false
}

/// Parse an `X.Y.Z` core with an optional `-prerelease` and `+build` tail,
/// returning the `(major, minor, patch, pre)` tuple when valid semver.
pub(crate) fn semver(v: &str) -> Option<(&str, &str, &str, Option<&str>)> {
    let (core, build) = v.split_once('+').map_or((v, None), |(c, b)| (c, Some(b)));
    if build.is_some_and(|b| !b.split('.').all(identifier)) {
        return None;
    }
    let (numbers, pre) = match core.split_once('-') {
        Some((numbers, pre)) if pre.split('.').all(identifier) => (numbers, Some(pre)),
        Some(_) => return None,
        None => (core, None),
    };
    let mut parts = numbers.split('.');
    let (major, minor, patch) = (parts.next()?, parts.next()?, parts.next()?);
    let numeric = |n: &str| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (n == "0" || !n.starts_with('0'))
    };
    (parts.next().is_none() && numeric(major) && numeric(minor) && numeric(patch))
        .then_some((major, minor, patch, pre))
}

fn identifier(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `isVersion`: the SEMVER pattern of `src/update/version.ts`.
pub fn is_version(v: &str) -> bool {
    semver(v).is_some()
}

/// `compareVersions` by semver precedence; build metadata does not affect ordering.
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let (Some(pa), Some(pb)) = (semver(a), semver(b)) else {
        return 0;
    };
    let number = |n: &str| n.parse::<f64>().unwrap_or(f64::INFINITY);
    for (x, y) in [(pa.0, pb.0), (pa.1, pb.1), (pa.2, pb.2)] {
        let d = number(x) - number(y);
        if d != 0.0 {
            return if d > 0.0 { 1 } else { -1 };
        }
    }
    match (pa.3, pb.3) {
        (ra, rb) if ra == rb => 0,
        (None, _) => 1,
        (_, None) => -1,
        (Some(ra), Some(rb)) => {
            let (xa, xb): (Vec<_>, Vec<_>) = (ra.split('.').collect(), rb.split('.').collect());
            for i in 0..xa.len().max(xb.len()) {
                let (Some(x), Some(y)) = (xa.get(i), xb.get(i)) else {
                    return if xa.get(i).is_none() { -1 } else { 1 };
                };
                if x == y {
                    continue;
                }
                let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
                return match (digits(x), digits(y)) {
                    (true, true) => {
                        let d = number(x) - number(y);
                        if d > 0.0 {
                            1
                        } else if d < 0.0 {
                            -1
                        } else {
                            0
                        }
                    }
                    (true, false) => -1,
                    (false, true) => 1,
                    // JavaScript `<` compares UTF-16 code units; identifiers are ASCII.
                    (false, false) => {
                        if x < y {
                            -1
                        } else {
                            1
                        }
                    }
                };
            }
            0
        }
    }
}
