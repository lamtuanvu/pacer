//! ECMAScript (`String`, `Number`, `Buffer`) semantics for bundled ports.
//!
//! The TypeScript plugins repeatedly rely on standard JavaScript methods
//! (`String.prototype.trim`, `.length`, `.slice`, `Number.prototype.toString`,
//! `Number.isSafeInteger`, `Buffer.from(…, "base64")`). This module reproduces
//! those semantics so a Rust port can match byte-for-byte.
//!
//! ## Known deviations
//!
//! `slice_utf16` splits a surrogate pair into U+FFFD, where JavaScript yields
//! a lone surrogate. This is documented in the SDK README (mirrors the plugin
//! plan's UTF-16 text rule).

use serde_json::Value;

/// ECMAScript `String.prototype.trim`: strip WhiteSpace and LineTerminator
/// from both ends. Includes U+FEFF (ZWNBSP); does NOT strip U+200B.
pub fn trim(s: &str) -> &str {
    let start = s.char_indices().find(|(_, c)| !is_ws(*c)).map(|(i, _)| i);
    let start = start.unwrap_or(s.len());
    let end = s
        .char_indices()
        .rev()
        .find(|(_, c)| !is_ws(*c))
        .map(|(i, _)| i + s[i..].chars().next().map_or(0, char::len_utf8))
        .unwrap_or(start);
    &s[start..end]
}

fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' // TAB
        | '\u{000a}' // LF
        | '\u{000b}' // VT
        | '\u{000c}' // FF
        | '\u{000d}' // CR
        | '\u{0020}' // SP
        | '\u{00a0}' // NBSP
        | '\u{1680}' // OGHAM SPACE MARK
        | '\u{2000}'
            ..='\u{200a}' // en quad .. hair space
        | '\u{2028}' // LS
        | '\u{2029}' // PS
        | '\u{202f}' // NNBSP
        | '\u{205f}' // MMSP
        | '\u{3000}' // IDEOGRAPHIC SPACE
        | '\u{feff}' // ZWNBSP
    )
}

/// ECMAScript `String.prototype.length`: count of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// ECMAScript `String.prototype.slice`, with negative indices measured from the
/// end. `end = None` means the end of the string. A slice that splits a
/// surrogate pair yields U+FFFD (documented deviation from JS's lone
/// surrogate).
pub fn slice_utf16(s: &str, start: i64, end: Option<i64>) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let len = units.len() as i64;
    let norm = |n: i64| -> usize {
        let n = if n < 0 { len + n } else { n };
        n.clamp(0, len) as usize
    };
    let s_idx = norm(start);
    let e_idx = end.map(norm).unwrap_or(len as usize);
    if s_idx >= e_idx {
        return String::new();
    }
    let slice = &units[s_idx..e_idx];
    let mut out = String::with_capacity(slice.len());
    let mut i = 0;
    while i < slice.len() {
        let u = slice[i];
        if (0xd800..=0xdbff).contains(&u) {
            if i + 1 < slice.len() && (0xdc00..=0xdfff).contains(&slice[i + 1]) {
                let cp = 0x10000 + ((u as u32 - 0xd800) << 10) + (slice[i + 1] as u32 - 0xdc00);
                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                i += 2;
            } else {
                out.push('\u{fffd}');
                i += 1;
            }
        } else if (0xdc00..=0xdfff).contains(&u) {
            out.push('\u{fffd}');
            i += 1;
        } else {
            out.push(char::from_u32(u as u32).unwrap_or('\u{fffd}'));
            i += 1;
        }
    }
    out
}

/// ECMAScript `Number.prototype.toString` through `ryu-js`. `-0` prints "0".
pub fn number_string(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}

/// `Number.isSafeInteger` over a JSON value: an integral number within
/// ±(2^53 − 1). A JSON `1.0` yields `Some(1)`; a non-number is `None`.
pub fn safe_integer(v: &Value) -> Option<i64> {
    let n = v.as_f64()?;
    if n.fract() != 0.0 {
        return None;
    }
    let max = (2f64).powi(53) - 1.0; // 9007199254740991
    if n < -max || n > max {
        return None;
    }
    Some(n as i64)
}

/// `typeof === "number" && isFinite` over a JSON value.
pub fn finite_number(v: &Value) -> Option<f64> {
    let n = v.as_f64()?;
    n.is_finite().then_some(n)
}

/// Base64 helpers with the wire's canonical padded form and `Buffer.from`'s
/// lenient form.
pub mod base64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// Canonical padded base64, as the plugin protocol carries bytes.
    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b = [
                chunk.first().copied().unwrap_or(0),
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    /// Canonical padded base64 only; anything else is None.
    pub fn decode(text: &str) -> Option<Vec<u8>> {
        if !text.len().is_multiple_of(4) {
            return None;
        }
        let pad = text.bytes().rev().take_while(|&c| c == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut bits: u32 = 0;
        let mut count = 0;
        let mut out = Vec::with_capacity(text.len() / 4 * 3);
        for c in text.bytes().take(text.len() - pad) {
            let v = ALPHABET.iter().position(|&a| a == c)?;
            bits = (bits << 6) | v as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
        }
        (bits == 0).then_some(out)
    }

    /// `Buffer.from(s, "base64")`: strip whitespace and padding, then decode,
    /// tolerating a length that is not a multiple of 4.
    pub fn decode_lenient(text: &str) -> Vec<u8> {
        let cleaned: String = text
            .chars()
            .filter(|c| !c.is_ascii_whitespace() && *c != '=')
            .collect();
        let mut padded = cleaned;
        while !padded.len().is_multiple_of(4) {
            padded.push('=');
        }
        decode(&padded).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_ecmascript() {
        assert_eq!(trim("\u{feff} a \u{3000}\n"), "a");
        assert_eq!(trim("\u{200b}a"), "\u{200b}a");
    }

    #[test]
    fn utf16_len_counts_code_units() {
        assert_eq!(utf16_len("a😀"), 3);
    }

    #[test]
    fn slice_follows_string_prototype() {
        assert_eq!(slice_utf16("hello", -3, None), "llo");
        assert_eq!(slice_utf16("hello", 0, Some(200)), "hello");
        assert_eq!(slice_utf16("a😀b", -2, None), "\u{fffd}b");
        assert_eq!(slice_utf16("abc", 2, Some(1)), "");
    }

    #[test]
    fn number_string_matches_number_to_string() {
        assert_eq!(number_string(0.0), "0");
        assert_eq!(number_string(-0.0), "0");
        assert_eq!(number_string(1e21), "1e+21");
        assert_eq!(number_string(1.5e-7), "1.5e-7");
        assert_eq!(number_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(
            number_string(123456789012345680000.0),
            "123456789012345680000"
        );
        assert_eq!(number_string(0.5), "0.5");
    }

    #[test]
    fn safe_integer_accepts_integral_floats_only() {
        use serde_json::json;
        assert_eq!(safe_integer(&json!(1.0)), Some(1));
        assert_eq!(
            safe_integer(&json!(9007199254740991u64)),
            Some(9007199254740991)
        );
        assert_eq!(safe_integer(&json!(9007199254740992u64)), None);
        assert_eq!(safe_integer(&json!(1.5)), None);
        assert_eq!(safe_integer(&json!("1")), None);
    }

    #[test]
    fn base64_lenient_matches_buffer_from() {
        assert_eq!(base64::decode_lenient("eA"), vec![0x78]);
        assert_eq!(base64::decode_lenient("e A=="), vec![0x78]);
        assert_eq!(base64::decode_lenient("eA==="), vec![0x78]);
        assert_eq!(base64::decode("eA"), None);
    }
}
