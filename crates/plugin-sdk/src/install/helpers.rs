use crate::install::sha256_hex;
use jiff::{Timestamp, tz::TimeZone};

/// SHA-256 over UTF-8, lowercase hex, including a leading BOM when present.
pub fn sha256(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

fn plain(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'_' | b'/' | b'.' | b':' | b'=' | b'@' | b'%' | b'+' | b'-'
                )
        })
}

/// Shell single quote: only a small unreserved alphabet stays literal.
pub fn shq(s: &str) -> String {
    if plain(s) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub fn shell_command(argv: &[String]) -> String {
    argv.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ")
}

/// Unix seconds to a local wall-clock backup name with collision suffixes.
/// The caller supplies the time zone; production uses `TimeZone::system()`.
pub fn backup_path<F>(path: &str, now: i64, tz: &TimeZone, exists: F) -> String
where
    F: Fn(&str) -> bool,
{
    let stamp = Timestamp::from_second(now)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(tz.clone());
    let day = format!(
        "{:04}{:02}{:02}",
        stamp.year(),
        stamp.month() as u8,
        stamp.day()
    );
    let time = format!(
        "{:02}{:02}{:02}",
        stamp.hour(),
        stamp.minute(),
        stamp.second()
    );
    let base = format!("{path}.pacer-bak-{day}-{time}");
    let mut candidate = base.clone();
    let mut suffix = 2;
    while exists(&candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

/// Named-zone lookup for callers that need an explicit zone (tests, fixtures).
pub fn zone(name: &str) -> Option<TimeZone> {
    TimeZone::get(name).ok()
}
