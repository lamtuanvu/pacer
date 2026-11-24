//! The `__PACER_BEGIN__` payload marker at a line start (`probe.ts:523-529`).
//! A line start means the start of input or after `\n`, `\r`, U+2028 or U+2029,
//! matching the JS `m` flag. Returns everything after the marker line.

const MARKER: &str = "__PACER_BEGIN__\n";

/// Returns the payload after the marker, or `Err(())` when no marker is found.
pub fn probe_payload(stdout: &str) -> Result<&str, ()> {
    let bytes = stdout.as_bytes();
    let mut i = 0usize;
    while i <= bytes.len() {
        let line_start = match i {
            0 => true,
            _ => {
                // The previous UTF-8 scalar ends at i (guaranteed at char
                // boundaries). Check its code point.
                let prev = stdout[..i].chars().next_back();
                match prev {
                    Some(ch) => matches!(ch as u32, 0x0a | 0x0d | 0x2028 | 0x2029),
                    None => false,
                }
            }
        };
        if line_start && bytes[i..].starts_with(MARKER.as_bytes()) {
            return Ok(&stdout[i + MARKER.len()..]);
        }
        // Advance by one full UTF-8 scalar boundary.
        let ch = stdout[i..].chars().next().ok_or(())?;
        i += ch.len_utf8();
    }
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_marker_at_start() {
        let s = format!("chatter\n{}payload", MARKER);
        assert_eq!(probe_payload(&s), Ok("payload"));
    }

    #[test]
    fn rejects_missing_marker() {
        assert_eq!(probe_payload("no marker here"), Err(()));
    }
}