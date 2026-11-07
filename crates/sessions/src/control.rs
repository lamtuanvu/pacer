//! Transport-independent viewer policy from `src/session/viewers.ts`. Socket queues remain in TS.
//! A 1.1 host has a single controller. A 1.2 host has none: every viewer that is not read-only types,
//! and the PTY size follows the most recently active client (ADR 0023).
use crate::version::{negotiate, parse_versions};
use serde_json::{Value, json};
struct Viewer {
    id: String,
    label: String,
    minor: u64,
    read_only: bool,
    took: bool,
    reply: bool,
    size: Option<(u16, u16)>,
}
#[derive(Default)]
pub struct Controller {
    viewers: Vec<Viewer>,
    holder: Option<String>,
    active: Option<String>,
    author: Option<String>,
    host: Option<([u64; 2], String)>,
    /// Policy effects in TS call order: markers, `["input", text]`, `["resize", cols, rows]`, `["release", label]`.
    pub events: Vec<Value>,
    pub messages: Vec<Value>,
}
impl Controller {
    /// A host that advertises `versions` to clients that send a range; `Default` is an unversioned 1.1 host.
    pub fn with_host(versions: [u64; 2], pacer: &str) -> Self {
        Self {
            host: Some((versions, pacer.into())),
            ..Self::default()
        }
    }
    fn shared(&self) -> bool {
        self.host.as_ref().is_some_and(|(v, _)| v[1] >= 2)
    }
    /// On a 1.2 host: not read-only, and a 1.1 client only between its take and release.
    fn may_type(&self, id: &str) -> bool {
        self.viewer(id)
            .is_some_and(|v| !v.read_only && (v.minor >= 2 || v.took))
    }
    pub fn holder(&self) -> Option<&str> {
        self.holder.as_deref().and_then(|id| self.label(id))
    }
    pub fn active(&self) -> Option<&str> {
        self.active.as_deref().and_then(|id| self.label(id))
    }
    fn label(&self, id: &str) -> Option<&str> {
        self.viewer(id).map(|v| v.label.as_str())
    }
    fn viewer(&self, id: &str) -> Option<&Viewer> {
        self.viewers.iter().find(|v| v.id == id)
    }
    fn viewer_mut(&mut self, id: &str) -> Option<&mut Viewer> {
        self.viewers.iter_mut().find(|v| v.id == id)
    }
    pub fn size(&self) -> usize {
        self.viewers.len()
    }
    fn state(&mut self, id: &str, reason: Option<&str>) {
        let shared = self.shared();
        let you = match self.viewer(id) {
            Some(v) if shared => {
                if v.minor >= 2 {
                    !v.read_only
                } else {
                    v.took
                }
            }
            _ => self.holder.as_deref() == Some(id),
        };
        let mut body = json!({"controller":self.holder(),"you":you});
        if let Some(reason) = reason {
            body["reason"] = json!(reason);
        }
        let host = self.host.clone();
        if let (Some(v), Some((versions, pacer))) = (self.viewer_mut(id), host)
            && v.reply
        {
            v.reply = false;
            body["versions"] = json!(versions);
            body["pacer"] = json!(pacer);
        }
        self.messages.push(json!({"id":id,"body":body}));
    }
    fn set(&mut self, holder: Option<&str>, reason: &str) {
        if self.holder.as_deref() == holder {
            return;
        }
        if let Some(old) = self.holder.take() {
            self.events
                .push(json!(["control-released", self.label(&old)]));
        }
        self.holder = holder.map(String::from);
        if let Some(id) = holder {
            self.events.push(json!(["control-taken", self.label(id)]));
        }
        let ids: Vec<String> = self.viewers.iter().map(|v| v.id.clone()).collect();
        for id in ids {
            self.state(&id, Some(reason));
        }
    }
    fn activate(&mut self, id: &str) {
        if self.active.as_deref() == Some(id) {
            return;
        }
        self.active = Some(id.into());
        if let Some((cols, rows)) = self.viewer(id).and_then(|v| v.size) {
            self.events.push(json!(["resize", cols, rows]));
        }
    }
    /// Caller has already validated hello's `v` and `from`. Returns false when the range is malformed or
    /// unsupported, or at capacity.
    pub fn join(&mut self, id: &str, label: &str, hello: &Value) -> bool {
        let versions = match hello.get("versions") {
            None => None,
            Some(raw) => match parse_versions(raw) {
                Some(v) => Some(v),
                None => return false,
            },
        };
        let host = self.host.as_ref().map_or([1, 1], |(v, _)| *v);
        let Some(minor) = negotiate(versions, host) else {
            return false;
        };
        if self.viewers.len() >= 16 || self.viewer(id).is_some() {
            return false;
        }
        self.viewers.push(Viewer {
            id: id.into(),
            label: label.into(),
            minor,
            read_only: hello.get("readOnly") == Some(&Value::Bool(true)),
            took: false,
            reply: versions.is_some() && self.host.is_some(),
            size: None,
        });
        self.state(id, None);
        self.events.push(json!(["attach", label]));
        true
    }
    pub fn disconnect(&mut self, id: &str) {
        let label = self.label(id).map(String::from);
        let was_holder = self.holder.as_deref() == Some(id);
        if was_holder {
            self.holder = None;
            self.events.push(json!(["control-released", label]));
            let peers: Vec<String> = self
                .viewers
                .iter()
                .filter(|v| v.id != id)
                .map(|v| v.id.clone())
                .collect();
            for peer in peers {
                self.state(&peer, Some("disconnected"));
            }
        }
        if self.author.as_deref() == Some(id) {
            self.author = None;
        }
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
        let joined = self.viewer(id).is_some();
        self.viewers.retain(|v| v.id != id);
        if joined {
            self.events.push(json!(["detach", label]));
        }
    }
    pub fn take(&mut self, id: &str, body: &Value) {
        let Some(v) = self.viewer(id) else {
            return;
        };
        if self.shared() {
            if v.read_only {
                self.state(id, Some("read-only"));
                return;
            }
            if let Some(v) = self.viewer_mut(id) {
                v.took = true;
            }
            self.state(id, None);
            self.activate(id);
        } else if self.holder.as_deref() == Some(id) {
            self.state(id, None);
        } else if self.holder.is_none() || body["force"] == Value::Bool(true) {
            self.set(Some(id), "taken");
        } else {
            self.state(id, Some("refused"));
        }
    }
    pub fn release(&mut self, id: &str) {
        if self.shared() {
            let Some(v) = self.viewer_mut(id).filter(|v| v.took) else {
                return;
            };
            v.took = false;
            let (minor, label) = (v.minor, v.label.clone());
            self.state(id, Some("released"));
            if minor < 2 {
                self.events.push(json!(["release", label]));
            }
        } else if self.holder.as_deref() == Some(id) {
            self.set(None, "released");
            self.events.push(json!(["release", self.label(id)]));
        }
    }
    /// `cursor` is true while the host's own cursor position report is recent.
    pub fn input(&mut self, id: &str, bytes: &[u8], cursor: bool) {
        let bytes = if self.shared() {
            if !self.may_type(id) {
                return;
            }
            strip_query_replies(bytes, cursor)
        } else if self.holder.as_deref() == Some(id) {
            bytes.to_vec()
        } else {
            return;
        };
        if bytes.is_empty() {
            return;
        }
        if self.shared() {
            if self.author.as_deref() != Some(id) {
                self.author = Some(id.into());
                self.events.push(json!(["input", self.label(id)]));
            }
            self.activate(id);
        }
        self.events
            .push(json!(["input", String::from_utf8_lossy(&bytes)]));
    }
    pub fn focus(&mut self, id: &str) {
        if self.shared() && self.may_type(id) {
            self.activate(id);
        }
    }
    pub fn resize(&mut self, id: &str, body: &Value) {
        let allowed = if self.shared() {
            self.may_type(id)
        } else {
            self.holder.as_deref() == Some(id)
        };
        if !allowed {
            return;
        }
        let Some(size) = dimension(&body["cols"], 1000).zip(dimension(&body["rows"], 500)) else {
            return;
        };
        if self.shared() {
            if let Some(v) = self.viewer_mut(id) {
                v.size = Some(size);
            }
            if self.active.as_deref() != Some(id) {
                return;
            }
        }
        self.events.push(json!(["resize", size.0, size.1]));
    }
}
fn dimension(v: &Value, max: u16) -> Option<u16> {
    let n = v.as_f64()?;
    (n >= 1.0 && n <= f64::from(max) && n.fract() == 0.0).then_some(n as u16)
}
/// Client replies to the terminal queries the host answers itself: DA1 and DA2 (`ESC [ ? … c`, `ESC [ > … c`),
/// OSC 10/11 colours, and cursor position reports (`ESC [ ?row ; col [; page] R`) only when `cursor` is set.
/// Mirrors `stripQueryReplies` in src/session/queries.ts.
pub fn strip_query_replies(bytes: &[u8], cursor: bool) -> Vec<u8> {
    let mut kept = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match reply_len(&bytes[i..], cursor) {
            Some(n) => i += n,
            None => {
                kept.push(bytes[i]);
                i += 1;
            }
        }
    }
    kept
}
fn reply_len(b: &[u8], cursor: bool) -> Option<usize> {
    if b.first() != Some(&0x1b) {
        return None;
    }
    match b.get(1)? {
        b'[' => {
            let marker = b.get(2).copied().filter(|c| *c == b'?' || *c == b'>');
            let start = 2 + usize::from(marker.is_some());
            let params = b[start..]
                .iter()
                .take_while(|c| c.is_ascii_digit() || **c == b';')
                .count();
            let end = start + params;
            match b.get(end)? {
                b'c' if marker.is_some() => Some(end + 1),
                b'R' if cursor && marker != Some(b'>') && cursor_params(&b[start..end]) => {
                    Some(end + 1)
                }
                _ => None,
            }
        }
        b']' => {
            if !(b.get(2..5) == Some(b"10;") || b.get(2..5) == Some(b"11;")) {
                return None;
            }
            let body = b[5..].iter().position(|c| *c == 0x07 || *c == 0x1b)? + 5;
            match b[body] {
                0x07 => Some(body + 1),
                _ if b.get(body + 1) == Some(&b'\\') => Some(body + 2),
                _ => None,
            }
        }
        _ => None,
    }
}
fn cursor_params(p: &[u8]) -> bool {
    let parts: Vec<&[u8]> = p.split(|c| *c == b';').collect();
    (parts.len() == 2 || parts.len() == 3) && parts.iter().all(|n| !n.is_empty())
}
pub fn valid_from(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| (0.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0)
}
/// JS sanitization and slice(0,64), retaining a possible lone UTF-16 surrogate.
/// Wire adapters must preserve these units rather than replacing the last unit.
pub fn label_units(label: &str) -> Vec<u16> {
    label
        .chars()
        .filter(|c| !matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'))
        .flat_map(|c| {
            let mut b = [0; 2];
            c.encode_utf16(&mut b).to_vec()
        })
        .take(64)
        .collect()
}
