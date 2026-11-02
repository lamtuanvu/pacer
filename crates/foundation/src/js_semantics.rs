/// JavaScript String.prototype.trim WhiteSpace and LineTerminator characters.
/// Unicode White_Space differs: it omits FEFF and includes characters JS keeps.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
            '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
            '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
            '\u{205F}' | '\u{3000}' | '\u{FEFF}'
        )
    })
}

pub trait JsTrim {
    fn js_trim(&self) -> &str;
}

impl JsTrim for str {
    fn js_trim(&self) -> &str {
        js_trim(self)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::js_trim;

    #[test]
    fn ecmascript_whitespace_table() {
        for c in [
            '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', ' ', '\u{00A0}',
            '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
            '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}',
            '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
        ] {
            assert_eq!(
                js_trim(&format!("{c}value{c}")),
                "value",
                "U+{:04X}",
                c as u32
            );
            assert_eq!(js_trim(&format!("{c}{c}")), "", "U+{:04X}", c as u32);
        }
        for c in ['\u{0085}', '\u{180E}', '\u{200B}'] {
            assert_eq!(js_trim(&format!("{c}value{c}")), format!("{c}value{c}"));
        }
    }
    #[test]
    fn ecmascript_whitespace_matches_bun() {
        for character in [
            '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', ' ', '\u{00A0}',
            '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
            '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}',
            '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}', '\u{0085}',
        ] {
            let value = format!("{character}x{character}");
            let output = std::process::Command::new("bun")
                .args([
                    "-e",
                    "console.log(JSON.stringify(Bun.argv.at(-1).trim()))",
                    &value,
                ])
                .output()
                .unwrap();
            assert!(output.status.success());
            let bun: String = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(js_trim(&value), bun, "U+{:04X}", character as u32);
        }
    }
}
