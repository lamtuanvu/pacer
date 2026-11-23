//! Terminal key decoding, ported from `src/dashboard/input.ts`.
//!
//! `Keys` keeps split escape sequences and UTF-8 input intact across terminal
//! chunks. It is pure: no I/O, no global state.

#[cfg(test)]
mod tests;

/// A parsed key. Named keys are the strings `"up"`, `"enter"`, etc.; printable
/// keys are the character itself. This mirrors the TypeScript `Key` alias.
pub type Key = String;

/// Terminal escape sequences in the order the TypeScript decoder checks them.
/// Longer sequences must be checked before their prefixes (e.g. `\x1b[` and
/// `\x1b[1~`), which the `starts_with` scan preserves by declaration order.
const SEQUENCES: &[(&str, &str)] = &[
    ("\x1b[A", "up"),
    ("\x1b[B", "down"),
    ("\x1b[C", "right"),
    ("\x1b[D", "left"),
    ("\x1bOA", "up"),
    ("\x1bOB", "down"),
    ("\x1bOC", "right"),
    ("\x1bOD", "left"),
    ("\x1b[Z", "backtab"),
    ("\x1b[5~", "pageup"),
    ("\x1b[6~", "pagedown"),
    ("\x1b[H", "home"),
    ("\x1b[F", "end"),
    ("\x1b[1~", "home"),
    ("\x1b[4~", "end"),
    ("\x1bOH", "home"),
    ("\x1bOF", "end"),
];

/// True when `text` is a strict prefix of a known sequence that could still be
/// arriving in a later chunk (so the decoder must wait before emitting it).
fn is_prefix(text: &str) -> bool {
    SEQUENCES
        .iter()
        .any(|(seq, _)| seq.starts_with(text) && *seq != text)
}

/// The stateful decoder. Call [`feed`](Keys::feed) for each terminal chunk and
/// [`flush`](Keys::flush) after an input pause to resolve a lone Escape.
#[derive(Default, Debug)]
pub struct Keys {
    pending: String,
}

impl Keys {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode a chunk of terminal input into keys.
    pub fn feed(&mut self, text: &str) -> Vec<Key> {
        self.pending.push_str(text);
        let mut out = Vec::new();
        while !self.pending.is_empty() {
            if is_prefix(&self.pending) {
                break;
            }
            if let Some((seq, key)) = SEQUENCES
                .iter()
                .find(|(seq, _)| self.pending.starts_with(seq))
            {
                out.push((*key).to_string());
                self.pending = self.pending[seq.len()..].to_string();
                continue;
            }
            // Array.from(pending)[0]: the first Unicode scalar and its byte length.
            let Some(ch) = self.pending.chars().next() else {
                break;
            };
            self.pending = self.pending[ch.len_utf8()..].to_string();
            out.push(match ch {
                '\x03' => "interrupt".to_string(),
                '\r' | '\n' => "enter".to_string(),
                '\x7f' | '\x08' => "backspace".to_string(),
                '\t' => "tab".to_string(),
                '\x1b' => "escape".to_string(),
                _ => ch.to_string(),
            });
        }
        out
    }

    /// A lone escape after a pause is the Escape key; anything else is dropped.
    pub fn flush(&mut self) -> Vec<Key> {
        let text = std::mem::take(&mut self.pending);
        if text == "\x1b" {
            vec!["escape".to_string()]
        } else {
            Vec::new()
        }
    }
}
