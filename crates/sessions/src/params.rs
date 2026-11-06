//! Session operation param bounds matching `src/api/ops-session.ts` and
//! `src/api/ops-agent-sessions.ts` Zod schemas. No dispatch or I/O.

use crate::targets::valid_task_id;

pub const MAX_SESSION_REQUEST: usize = 200_000;
pub const MAX_EXECUTOR_LEN: usize = 256;
pub const MAX_ATTACHMENTS: usize = 20;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Task / session id (`^[A-Za-z0-9_-]{1,128}$`).
pub fn valid_session_id(id: &str) -> bool {
    valid_task_id(id)
}

/// `draftId` / `attachmentId` (Zod uuid pattern with nil/max sentinels).
pub fn valid_draft_uuid(text: &str) -> bool {
    if text.len() != 36 {
        return false;
    }
    if ![8, 13, 18, 23]
        .iter()
        .all(|index| text.as_bytes()[*index] == b'-')
    {
        return false;
    }
    if !text.bytes().all(|byte| byte == b'-' || byte.is_ascii_hexdigit()) {
        return false;
    }
    if text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = text.as_bytes();
    matches!(bytes[14], b'1'..=b'8')
        && matches!(
            bytes[19].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

/// Agent session record id (`z.string().uuid()` — any RFC variant/version).
pub fn valid_agent_uuid(text: &str) -> bool {
    if text.len() != 36 {
        return false;
    }
    if ![8, 13, 18, 23]
        .iter()
        .all(|index| text.as_bytes()[*index] == b'-')
    {
        return false;
    }
    let bytes = text.as_bytes();
    if !bytes.iter().all(|byte| byte.is_ascii_hexdigit() || *byte == b'-') {
        return false;
    }
    matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

/// Zod `.max(n)` on strings counts Unicode scalar values, not UTF-16 code units.
pub fn unicode_len(text: &str) -> usize {
    text.chars().count()
}

pub fn bounded_unicode(text: &str, min: usize, max: usize) -> bool {
    let len = unicode_len(text);
    len >= min && len <= max
}

/// Positive safe integer (`z.number().int().positive()` with JS max).
pub fn valid_expect_rev(value: f64) -> bool {
    value.is_finite()
        && value.fract() == 0.0
        && value >= 1.0
        && value <= MAX_SAFE_INTEGER as f64
}
