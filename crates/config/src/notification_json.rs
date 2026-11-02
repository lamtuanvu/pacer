//! JSON settings retain JavaScript strings, including individual UTF-16 units
//! produced by object spread. serde_json::Value cannot represent lone surrogates.
use std::path::Path;
#[derive(Clone)]
enum Json {
    Object(Vec<(Vec<u16>, Json)>),
    Array(Vec<Json>),
    String(Vec<u16>),
    Scalar(serde_json::Value),
}
struct Parser<'a> {
    text: &'a str,
    at: usize,
}
impl Parser<'_> {
    fn ws(&mut self) {
        while self
            .text
            .as_bytes()
            .get(self.at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.at += 1;
        }
    }
    fn take(&mut self, b: u8) -> Option<()> {
        self.ws();
        if self.text.as_bytes().get(self.at) != Some(&b) {
            return None;
        }
        self.at += 1;
        Some(())
    }
    fn string(&mut self) -> Option<Vec<u16>> {
        self.take(b'"')?;
        let mut units = Vec::new();
        loop {
            let b = *self.text.as_bytes().get(self.at)?;
            self.at += 1;
            match b {
                b'"' => return Some(units),
                b'\\' => {
                    let escaped = *self.text.as_bytes().get(self.at)?;
                    self.at += 1;
                    units.push(match escaped {
                        b'"' => 34,
                        b'\\' => 92,
                        b'/' => 47,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let hex = self.text.get(self.at..self.at + 4)?;
                            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return None;
                            }
                            let n = u16::from_str_radix(hex, 16).ok()?;
                            self.at += 4;
                            n
                        }
                        _ => return None,
                    });
                }
                0..=31 => return None,
                _ => {
                    self.at -= 1;
                    let c = self.text[self.at..].chars().next()?;
                    self.at += c.len_utf8();
                    units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                }
            }
        }
    }
    fn value(&mut self) -> Option<Json> {
        enum Frame {
            Array(Vec<Json>),
            Object(Vec<(Vec<u16>, Json)>, Vec<u16>),
        }
        let mut stack = Vec::new();
        let mut ready = None;
        loop {
            if let Some(value) = ready.take() {
                match stack.pop() {
                    None => return Some(value),
                    Some(Frame::Array(mut items)) => {
                        items.push(value);
                        self.ws();
                        match self.text.as_bytes().get(self.at)? {
                            b']' => {
                                self.at += 1;
                                ready = Some(Json::Array(items));
                            }
                            b',' => {
                                self.at += 1;
                                stack.push(Frame::Array(items));
                            }
                            _ => return None,
                        }
                    }
                    Some(Frame::Object(mut items, key)) => {
                        if let Some((_, old)) = items.iter_mut().find(|(k, _)| k == &key) {
                            *old = value;
                        } else {
                            items.push((key, value));
                        }
                        self.ws();
                        match self.text.as_bytes().get(self.at)? {
                            b'}' => {
                                self.at += 1;
                                ready = Some(Json::Object(items));
                            }
                            b',' => {
                                self.at += 1;
                                let key = self.string()?;
                                self.take(b':')?;
                                stack.push(Frame::Object(items, key));
                            }
                            _ => return None,
                        }
                    }
                }
                continue;
            }
            self.ws();
            match *self.text.as_bytes().get(self.at)? {
                b'"' => ready = Some(Json::String(self.string()?)),
                b'{' => {
                    self.at += 1;
                    self.ws();
                    if self.text.as_bytes().get(self.at) == Some(&b'}') {
                        self.at += 1;
                        ready = Some(Json::Object(Vec::new()));
                    } else {
                        let key = self.string()?;
                        self.take(b':')?;
                        stack.push(Frame::Object(Vec::new(), key));
                    }
                }
                b'[' => {
                    self.at += 1;
                    self.ws();
                    if self.text.as_bytes().get(self.at) == Some(&b']') {
                        self.at += 1;
                        ready = Some(Json::Array(Vec::new()));
                    } else {
                        stack.push(Frame::Array(Vec::new()));
                    }
                }
                _ => {
                    let start = self.at;
                    while self.text.as_bytes().get(self.at).is_some_and(|b| {
                        !matches!(b, b',' | b']' | b'}' | b' ' | b'\t' | b'\r' | b'\n')
                    }) {
                        self.at += 1;
                    }
                    let token = self.text.get(start..self.at)?;
                    let scalar = match token {
                        "null" | "true" | "false" => serde_json::from_str(token).ok()?,
                        _ => serde_json::Number::from_f64(parse_number(token)?)
                            .map_or(serde_json::Value::Null, serde_json::Value::Number),
                    };
                    ready = Some(Json::Scalar(scalar));
                }
            }
        }
    }
}

fn parse_number(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut at = usize::from(bytes.first() == Some(&b'-'));
    match bytes.get(at)? {
        b'0' => at += 1,
        b'1'..=b'9' => {
            at += 1;
            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
        }
        _ => return None,
    }
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
    }
    if bytes.get(at).is_some_and(|b| matches!(b, b'e' | b'E')) {
        at += 1;
        if bytes.get(at).is_some_and(|b| matches!(b, b'+' | b'-')) {
            at += 1;
        }
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
    }
    if at != bytes.len() {
        return None;
    }
    text.parse().ok()
}
fn json_number(value: &serde_json::Number) -> String {
    let Some(n) = value.as_f64() else {
        return "null".into();
    };
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.abs() >= 1e21 || n.abs() < 1e-6 {
        let scientific = format!("{n:e}");
        if let Some((mantissa, exponent)) = scientific.split_once('e') {
            return format!(
                "{mantissa}e{}{exponent}",
                if exponent.starts_with('-') { "" } else { "+" }
            );
        }
        return scientific;
    }
    n.to_string()
}
fn read(path: &Path) -> Option<Json> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut parser = Parser { text: &text, at: 0 };
    let value = parser.value()?;
    parser.ws();
    (parser.at == text.len()).then_some(value)
}
fn quoted(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Ok(c) => match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{0008}' => out.push_str("\\b"),
                '\u{000C}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c <= '\u{001F}' => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            },
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}
fn index(key: &[u16]) -> Option<u32> {
    let text = String::from_utf16(key).ok()?;
    let n = text.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == text).then_some(n)
}
fn stringify(value: &Json) -> String {
    enum Work<'a> {
        Value(&'a Json),
        Text(String),
    }
    let mut work = vec![Work::Value(value)];
    let mut out = String::new();
    while let Some(next) = work.pop() {
        match next {
            Work::Text(text) => out.push_str(&text),
            Work::Value(Json::String(s)) => out.push_str(&quoted(s)),
            Work::Value(Json::Scalar(serde_json::Value::Number(n))) => {
                out.push_str(&json_number(n))
            }
            Work::Value(Json::Scalar(v)) => out.push_str(&v.to_string()),
            Work::Value(Json::Array(items)) => {
                out.push('[');
                work.push(Work::Text("]".into()));
                for (i, item) in items.iter().enumerate().rev() {
                    work.push(Work::Value(item));
                    if i > 0 {
                        work.push(Work::Text(",".into()));
                    }
                }
            }
            Work::Value(Json::Object(items)) => {
                let mut ordered = items.iter().enumerate().collect::<Vec<_>>();
                ordered.sort_by_key(|(at, (key, _))| {
                    index(key).map_or((1, *at as u64), |n| (0, u64::from(n)))
                });
                out.push('{');
                work.push(Work::Text("}".into()));
                for (i, (_, (key, value))) in ordered.iter().enumerate().rev() {
                    work.push(Work::Value(value));
                    work.push(Work::Text(":".into()));
                    work.push(Work::Text(quoted(key)));
                    if i > 0 {
                        work.push(Work::Text(",".into()));
                    }
                }
            }
        }
    }
    out
}

fn notification(value: &Json) -> Option<String> {
    let Json::Object(items) = value else {
        return None;
    };
    let (_, Json::String(level)) = items
        .iter()
        .find(|(k, _)| k == &"notifications".encode_utf16().collect::<Vec<_>>())?
    else {
        return None;
    };
    String::from_utf16(level).ok()
}
pub(super) fn level(path: &Path) -> Option<String> {
    notification(&read(path)?)
}
pub(super) fn settings(path: &Path, level: &str) -> Vec<u8> {
    let mut entries = match read(path) {
        Some(Json::Object(items)) => items,
        Some(Json::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string().encode_utf16().collect(), v))
            .collect(),
        Some(Json::String(units)) => units
            .into_iter()
            .enumerate()
            .map(|(i, v)| {
                (
                    i.to_string().encode_utf16().collect(),
                    Json::String(vec![v]),
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    let key = "notifications".encode_utf16().collect::<Vec<_>>();
    let value = Json::String(level.encode_utf16().collect());
    if let Some((_, old)) = entries.iter_mut().find(|(k, _)| k == &key) {
        *old = value;
    } else {
        entries.push((key, value));
    }
    stringify(&Json::Object(entries)).into_bytes()
}
