//! Streaming plain-line transcript matching `src/session/plain.ts`.
use std::str::from_utf8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Text,
    Escape,
    Csi,
    String,
    StringEscape,
}

/// Only completed lines are emitted so byte offsets stay valid for stdout readers.
pub struct PlainText {
    decode_pending: Vec<u8>,
    state: State,
    line: String,
    cr: bool,
    utf8_pending: u32,
}

impl Default for PlainText {
    fn default() -> Self {
        Self::new()
    }
}

impl PlainText {
    pub fn new() -> Self {
        Self {
            decode_pending: Vec::new(),
            state: State::Text,
            line: String::new(),
            cr: false,
            utf8_pending: 0,
        }
    }

    pub fn at_boundary(&self) -> bool {
        self.state == State::Text && self.utf8_pending == 0
    }

    pub fn push(&mut self, data: &[u8]) -> String {
        for &byte in data {
            if (byte & 0xc0) == 0x80 {
                self.utf8_pending = self.utf8_pending.saturating_sub(1);
            } else {
                self.utf8_pending = if (0xf0..=0xf4).contains(&byte) {
                    3
                } else if (0xe0..=0xef).contains(&byte) {
                    2
                } else if (0xc2..=0xdf).contains(&byte) {
                    1
                } else {
                    0
                };
            }
        }
        self.decode_pending.extend_from_slice(data);
        let text = take_valid_utf8(&mut self.decode_pending);
        self.consume(&text)
    }

    pub fn flush(&mut self) -> String {
        let tail = if self.decode_pending.is_empty() {
            String::new()
        } else {
            let rest = std::mem::take(&mut self.decode_pending);
            String::from_utf8_lossy(&rest).into_owned()
        };
        let mut out = self.consume(&tail);
        out.push_str(&self.line);
        self.line.clear();
        out
    }

    fn consume(&mut self, text: &str) -> String {
        let mut out = String::new();
        for ch in text.chars() {
            match self.state {
                State::Escape => {
                    if (' '..='/').contains(&ch) {
                        continue;
                    }
                    self.state = if ch == '[' {
                        State::Csi
                    } else if "]PX^_".contains(ch) {
                        State::String
                    } else {
                        State::Text
                    };
                    continue;
                }
                State::Csi => {
                    if ('@'..='~').contains(&ch) {
                        self.state = State::Text;
                    }
                    continue;
                }
                State::String => {
                    if ch == '\u{0007}' || ch == '\u{009c}' {
                        self.state = State::Text;
                    } else if ch == '\u{001b}' {
                        self.state = State::StringEscape;
                    }
                    continue;
                }
                State::StringEscape => {
                    self.state = if ch == '\\' {
                        State::Text
                    } else {
                        State::String
                    };
                    continue;
                }
                State::Text => {}
            }
            if ch == '\u{009b}' {
                self.state = State::Csi;
                continue;
            }
            if "\u{009d}\u{0090}\u{0098}\u{009e}\u{009f}".contains(ch) {
                self.state = State::String;
                continue;
            }
            if ch == '\u{001b}' {
                self.state = State::Escape;
                continue;
            }
            if ch == '\n' {
                out.push_str(&self.line);
                out.push('\n');
                self.line.clear();
                self.cr = false;
                continue;
            }
            if ch == '\r' {
                self.cr = true;
                continue;
            }
            if ch == '\u{0008}' {
                self.line.pop();
                continue;
            }
            if (ch < ' ' && ch != '\t') || ch == '\u{007f}' {
                continue;
            }
            if self.cr {
                self.line.clear();
                self.cr = false;
            }
            self.line.push(ch);
        }
        out
    }
}

fn take_valid_utf8(buf: &mut Vec<u8>) -> String {
    if buf.is_empty() {
        return String::new();
    }
    match from_utf8(buf) {
        Ok(text) => {
            let out = text.to_string();
            buf.clear();
            out
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let taken: Vec<u8> = buf.drain(..valid).collect();
            String::from_utf8(taken).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn chunked_csi_osc_dcs_matches_typescript() {
        let corpus = serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../test/fixtures/sessions/host-corpus.json"
        ))
        .unwrap();
        let row = &corpus["plain"][0];
        let mut plain = PlainText::new();
        let mut push_out = Vec::new();
        for chunk in row["chunks"].as_array().unwrap() {
            push_out.push(plain.push(&hex(chunk.as_str().unwrap())));
        }
        let expected_push: Vec<String> = row["pushOut"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(push_out, expected_push);
        assert_eq!(plain.flush(), row["flushOut"].as_str().unwrap());
    }
}
