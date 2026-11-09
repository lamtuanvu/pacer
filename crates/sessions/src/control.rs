//! Transport-independent viewer policy from `src/session/viewers.ts`. Socket queues remain in TS.
//! A 1.1 host has a single controller. A 1.2 host has none: every viewer that is not read-only types,
//! the PTY size follows the most recently active client (ADR 0023), and pacer's automated input flows
//! through the delivery window (ADR 0023, decision 4) that `src/session/viewers.ts` `ViewerHub` owns.
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
    /// Its delivery window expired before it typed; its input is dropped until a new deliver or a cancel (ADR 0023).
    expired_unused: bool,
}
/// Delivery window timing (ADR 0023, decision 4), defaulted to the product values.
#[derive(Clone, Copy)]
pub struct DeliveryTiming {
    pub quiet_ms: u64,
    pub window_ms: u64,
    pub timeout_ms: u64,
    pub max_window_ms: u64,
}
impl Default for DeliveryTiming {
    fn default() -> Self {
        Self {
            quiet_ms: 1500,
            window_ms: 2000,
            timeout_ms: 10_000,
            max_window_ms: 10_000,
        }
    }
}
struct Window {
    viewer: String,
    window_deadline: u64,
    cap_deadline: u64,
    typing: bool,
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
    timing: DeliveryTiming,
    refuse_deliver: bool,
    /// Virtual clock in ms; the characterization driver advances it with `advance`. `None` = never typed (quiet).
    now: u64,
    last_input_at: Option<u64>,
    last_input_from: Option<String>,
    requests: Vec<(String, u64)>,
    window: Option<Window>,
    held: Vec<(String, Vec<u8>)>,
    pending_line: Option<String>,
    pending_chars: usize,
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
            expired_unused: false,
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
        // Delivery window: drop pending requests and end the window if its owner left (holds finish), else repump (TS close).
        self.requests.retain(|(viewer, _)| viewer.as_str() != id);
        if self.window.as_ref().is_some_and(|w| w.viewer == id) {
            self.finish(None);
        } else {
            self.pump();
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
        if self.shared() {
            // Gate first: read-only viewers, and 1.1 clients that have not taken, cannot type (ADR 0023).
            if !self.may_type(id) {
                return;
            }
            if self.viewer(id).is_some_and(|v| v.expired_unused) {
                return;
            }
            let bytes = strip_query_replies(bytes, cursor);
            if bytes.is_empty() {
                return;
            }
            if self.window.as_ref().is_some_and(|w| w.viewer == id) {
                // The requester's own paste and Enter do not delay the next delivery.
                if let Some(win) = self.window.as_mut() {
                    win.typing = true;
                }
                self.apply(id, &bytes);
            } else {
                self.last_input_at = Some(self.now);
                self.last_input_from = self.label(id).map(String::from);
                if self.window.is_some() {
                    self.held.push((id.into(), bytes));
                } else {
                    self.apply(id, &bytes);
                }
            }
            self.pump();
        } else if self.holder.as_deref() == Some(id) {
            let bytes = bytes.to_vec();
            if !bytes.is_empty() {
                self.events
                    .push(json!(["input", String::from_utf8_lossy(&bytes)]));
            }
        }
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
    pub fn set_delivery(&mut self, timing: DeliveryTiming) {
        self.timing = timing;
    }
    pub fn set_refuse_deliver(&mut self, v: bool) {
        self.refuse_deliver = v;
    }
    /// Advance the virtual clock and run whatever the host's delivery timers would fire (a test driver).
    pub fn advance(&mut self, ms: u64) {
        self.now = self.now.saturating_add(ms);
        self.expire_window();
        self.pump();
    }
    /// Deliver request from `src/session/viewers.ts` `deliverFrame`, behind the shared (1.2) minor gate.
    pub fn deliver(&mut self, id: &str, body: &Value) {
        if !self.shared() {
            return;
        }
        let Some(v) = self.viewer(id) else { return };
        if v.minor < 2 {
            return;
        }
        if v.read_only {
            self.deliver_ok(
                id,
                json!({"ok":false,"cause":"read-only","reason":"read-only viewers cannot deliver input"}),
            );
            return;
        }
        if self.refuse_deliver {
            self.deliver_ok(
                id,
                json!({"ok":false,"cause":"refused","reason":"this terminal does not accept automated input"}),
            );
            return;
        }
        let done = body.get("done") == Some(&Value::Bool(true));
        let cancel = body.get("cancel") == Some(&Value::Bool(true));
        let owns = self.window.as_ref().is_some_and(|w| w.viewer == id);
        let queued = self.requests.iter().position(|(viewer, _)| viewer == id);
        if !done || cancel {
            if let Some(v) = self.viewer_mut(id) {
                v.expired_unused = false;
            }
        }
        if done || cancel {
            if owns {
                let result = if done { json!({"ok": true}) } else { cancelled_value() };
                self.finish(Some(&result));
            } else if let Some(index) = queued {
                self.requests.remove(index);
                self.deliver_ok(id, cancelled_value());
                self.pump();
            }
            return;
        }
        if owns || queued.is_some() {
            self.deliver_ok(
                id,
                json!({"ok":false,"cause":"duplicate","reason":"a delivery is already pending"}),
            );
            return;
        }
        self.requests.push((id.into(), self.now + self.timing.timeout_ms));
        self.pump();
    }
    fn apply(&mut self, id: &str, bytes: &[u8]) {
        let delivery = self.window.as_ref().is_some_and(|w| w.viewer == id);
        if self.author.as_deref() != Some(id) {
            self.author = Some(id.into());
            self.events.push(json!(["input", self.label(id)]));
        }
        // The window owner's delivery is recorded but neither makes it active nor counts as typing.
        if self.viewer(id).is_some() && !delivery {
            self.activate(id);
        }
        self.events
            .push(json!(["input", String::from_utf8_lossy(bytes)]));
        let (count, typed) = pending_after(bytes, self.pending_chars);
        self.pending_chars = count;
        self.pending_line = if count == 0 {
            None
        } else if typed {
            Some(self.label(id).map(String::from).unwrap_or_default())
        } else {
            self.pending_line.clone()
        };
    }
    fn finish(&mut self, result: Option<&Value>) {
        let Some(window) = self.window.take() else { return };
        let held = std::mem::take(&mut self.held);
        for (viewer, bytes) in held {
            self.apply(&viewer, &bytes);
        }
        if let Some(res) = result {
            if res.get("ok") == Some(&Value::Bool(true)) {
                let label = self.label(&window.viewer).map(String::from);
                let ids: Vec<String> = self
                    .viewers
                    .iter()
                    .filter(|v| v.minor >= 2)
                    .map(|v| v.id.clone())
                    .collect();
                for id in ids {
                    self.deliver_ok(&id, json!({"ok": true, "label": label}));
                }
            } else {
                self.deliver_ok(&window.viewer, res.clone());
            }
        }
        self.pump();
    }
    fn grant(&mut self, id: &str) {
        self.window = Some(Window {
            viewer: id.into(),
            window_deadline: self.now + self.timing.window_ms,
            cap_deadline: self.now + self.timing.max_window_ms,
            typing: false,
        });
        self.deliver_ok(id, json!({"windowMs": self.timing.window_ms}));
    }
    fn expire_window(&mut self) {
        match &self.window {
            Some(w) if !w.typing && self.now >= w.window_deadline => {}
            Some(w) if self.now >= w.cap_deadline => {
                self.finish(Some(&cap_expired_value()));
                return;
            }
            _ => return,
        }
        let id = self
            .window
            .as_ref()
            .map(|w| w.viewer.clone())
            .unwrap_or_default();
        if let Some(v) = self.viewer_mut(&id) {
            v.expired_unused = true;
        }
        self.finish(Some(&expired_unused_value()));
    }
    fn pump(&mut self) {
        let now = self.now;
        let mut i = 0;
        while i < self.requests.len() {
            if now >= self.requests[i].1 {
                let (viewer, _) = self.requests.remove(i);
                let failure = self.failure();
                self.deliver_ok(&viewer, failure);
            } else {
                i += 1;
            }
        }
        let quiet = self
            .last_input_at
            .map_or(true, |at| self.now >= at + self.timing.quiet_ms);
        if self.window.is_none()
            && !self.requests.is_empty()
            && self.pending_line.is_none()
            && quiet
        {
            let (viewer, _) = self.requests.remove(0);
            self.grant(&viewer);
        }
    }
    fn failure(&self) -> Value {
        if let Some(line) = &self.pending_line {
            return json!({"ok":false,"cause":"pending","from":line,"reason":format!("pending input from {line}")});
        }
        if let Some(w) = &self.window {
            let from = self.label(&w.viewer).unwrap_or(&w.viewer);
            return json!({"ok":false,"cause":"busy","from":from,"reason":format!("another delivery from {from} is in progress")});
        }
        let from = self
            .last_input_from
            .clone()
            .unwrap_or_else(|| "another client".into());
        json!({"ok":false,"cause":"input","from":from,"reason":format!("recent input from {from}")})
    }
    fn deliver_ok(&mut self, id: &str, body: Value) {
        self.messages.push(json!({"id": id, "body": body}));
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
fn expired_unused_value() -> Value {
    json!({"ok":false,"cause":"expired-unused","reason":"the delivery window expired before any input was typed"})
}
fn cancelled_value() -> Value {
    json!({"ok":false,"cause":"cancelled","reason":"the delivery was cancelled"})
}
fn cap_expired_value() -> Value {
    json!({"ok":false,"cause":"expired","reason":"the delivery window expired"})
}
/// The pending-line heuristic from `pendingAfter` in src/session/viewers.ts: roughly how many characters wait unsent.
/// Each printable character adds one, Backspace or DEL removes one, and Enter, Ctrl-C, Ctrl-U or a lone Esc clears the
/// line. Escape sequences (arrows, function keys, bracketed-paste markers) change nothing.
pub fn pending_after(bytes: &[u8], count: usize) -> (usize, bool) {
    let mut count = count;
    let mut typed = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            if i == bytes.len() - 1 {
                count = 0;
            } else {
                i = escape_end(bytes, i);
            }
        } else if b == 0x0d || b == 0x0a || b == 0x03 || b == 0x15 {
            count = 0;
        } else if b == 0x7f || b == 0x08 {
            count = count.saturating_sub(1);
        } else if b >= 0x20 && (b & 0xc0) != 0x80 {
            count += 1;
            typed = true;
        }
        i += 1;
    }
    (count, typed)
}
/// Index of the last byte of the escape sequence starting at `i`, mirroring `escapeEnd` in src/session/viewers.ts.
fn escape_end(bytes: &[u8], i: usize) -> usize {
    let Some(&kind) = bytes.get(i + 1) else {
        return i;
    };
    if kind == 0x5b {
        let mut j = i + 2;
        while j < bytes.len() && !(bytes[j] >= 0x40 && bytes[j] <= 0x7e) {
            j += 1;
        }
        return j;
    }
    if matches!(kind, 0x5d | 0x50 | 0x5e | 0x5f | 0x58) {
        let mut j = i + 2;
        while j < bytes.len() && bytes[j] != 0x07 && !(bytes[j] == 0x1b && bytes.get(j + 1) == Some(&0x5c))
        {
            j += 1;
        }
        return if bytes.get(j) == Some(&0x1b) { j + 1 } else { j };
    }
    if kind == 0x4f {
        i + 2
    } else {
        i + 1
    }
}
