//! `Number(raw)` plus safe-integer validation from the TS WebSocket route.
use crate::targets::js_space;
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid from offset")]
pub struct InvalidOffset;
pub fn parse_from(raw: Option<&str>) -> Result<Option<u64>, InvalidOffset> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Err(InvalidOffset);
    }
    let s = raw.trim_matches(js_space);
    let number = if s.is_empty() {
        0.0
    } else if s.starts_with("0x")
        || s.starts_with("0X")
        || s.starts_with("0b")
        || s.starts_with("0B")
        || s.starts_with("0o")
        || s.starts_with("0O")
    {
        let radix = match s.as_bytes()[1] {
            b'x' | b'X' => 16,
            b'b' | b'B' => 2,
            _ => 8,
        };
        let digits = &s[2..];
        if digits.is_empty() {
            return Err(InvalidOffset);
        }
        let mut n = 0.0;
        for c in digits.chars() {
            let digit = c.to_digit(radix).ok_or(InvalidOffset)?;
            n = n * f64::from(radix) + f64::from(digit);
            if n > 9_007_199_254_740_991.0 {
                return Err(InvalidOffset);
            }
        }
        n
    } else {
        // Rust also accepts `inf`; JS Number does not. Safe validation rejects
        // Infinity/NaN regardless, and only JS decimal syntax can reach here.
        if !s
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
        {
            return Err(InvalidOffset);
        }
        s.parse::<f64>().map_err(|_| InvalidOffset)?
    };
    if !(0.0..=9_007_199_254_740_991.0).contains(&number) || number.fract() != 0.0 {
        return Err(InvalidOffset);
    }
    Ok(Some(number as u64))
}
