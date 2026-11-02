//! CLI attach keyboard handling, mirroring `src/session/attach.ts`.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Frame(u8, Vec<u8>),
    Prompt(String),
}

#[derive(Default)]
pub struct AttachKeys {
    controlling: bool,
    escaped: bool,
    terminal_escape: Option<Escape>,
    requested: bool,
    confirming: bool,
    takeover: bool,
}

#[derive(Clone, Copy)]
enum Escape {
    Esc,
    Csi,
    Ss3,
    String,
    StringEsc,
}

impl AttachKeys {
    pub fn new(takeover: bool) -> Self {
        Self {
            takeover,
            ..Self::default()
        }
    }
    pub fn take(&mut self, force: bool, out: &mut Vec<Action>) {
        self.requested = true;
        out.push(Action::Frame(
            8,
            if force {
                br#"{"force":true}"#.to_vec()
            } else {
                b"{}".to_vec()
            },
        ));
    }
    pub fn control_state(
        &mut self,
        you: bool,
        controller: Option<&str>,
        reason: Option<&str>,
        out: &mut Vec<Action>,
    ) {
        if self.controlling != you {
            self.escaped = false;
        }
        self.controlling = you;
        if self.requested && (you || reason == Some("refused")) {
            self.requested = false;
            if !you && controller.is_some_and(|s| !s.is_empty()) {
                self.confirming = true;
                let label: String = controller
                    .unwrap_or_default()
                    .chars()
                    .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'))
                    .collect();
                out.push(Action::Prompt(format!(
                    "Someone is in control from {label}. Take over? [y/N] "
                )));
            }
        }
        if you || controller.is_none_or(str::is_empty) {
            self.confirming = false;
        }
    }
    pub fn push(&mut self, data: &[u8], out: &mut Vec<Action>) -> bool {
        let mut pending = Vec::new();
        fn flush(pending: &mut Vec<u8>, out: &mut Vec<Action>) {
            if !pending.is_empty() {
                out.push(Action::Frame(10, std::mem::take(pending)));
            }
        }
        for &byte in data {
            if !self.controlling {
                if let Some(state) = self.terminal_escape {
                    self.terminal_escape = match state {
                        Escape::Esc => match byte {
                            91 => Some(Escape::Csi),
                            79 => Some(Escape::Ss3),
                            93 | 80 | 94 | 95 | 88 => Some(Escape::String),
                            0x30..=0x7e => None,
                            _ => Some(Escape::Esc),
                        },
                        Escape::Csi | Escape::Ss3 => {
                            if (0x40..=0x7e).contains(&byte) {
                                None
                            } else {
                                Some(state)
                            }
                        }
                        Escape::String | Escape::StringEsc => {
                            if byte == 7 || (matches!(state, Escape::StringEsc) && byte == 92) {
                                None
                            } else if byte == 27 {
                                Some(Escape::StringEsc)
                            } else {
                                Some(Escape::String)
                            }
                        }
                    };
                    continue;
                }
                if byte == 27 {
                    self.terminal_escape = Some(Escape::Esc);
                    continue;
                }
                if self.confirming {
                    self.confirming = false;
                    out.push(Action::Prompt("\n".into()));
                    if byte == b'y' || byte == b'Y' {
                        self.take(true, out);
                    }
                    continue;
                }
                if byte == b'q' || byte == 3 {
                    return true;
                }
                if byte == b'c' {
                    self.take(false, out);
                }
            } else if self.escaped {
                self.escaped = false;
                if byte == b'd' {
                    flush(&mut pending, out);
                    return true;
                }
                if byte == b'r' {
                    flush(&mut pending, out);
                    if self.takeover {
                        out.push(Action::Prompt(
                            "Releasing hands the task back for review.\n".into(),
                        ));
                    }
                    out.push(Action::Frame(9, b"{}".to_vec()));
                } else if byte == 29 {
                    pending.push(29);
                } else {
                    pending.extend_from_slice(&[29, byte]);
                }
            } else if byte == 29 {
                flush(&mut pending, out);
                self.escaped = true;
            } else {
                pending.push(byte);
            }
        }
        flush(&mut pending, out);
        false
    }
}
