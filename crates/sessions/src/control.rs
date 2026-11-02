//! Transport-independent single-controller policy. Socket queues remain in TS.
use serde_json::{Value, json};
#[derive(Default)]
pub struct Controller {
    viewers: Vec<(String, String)>,
    holder: Option<String>,
    pub events: Vec<Value>,
    pub messages: Vec<Value>,
}
impl Controller {
    pub fn holder(&self) -> Option<&str> {
        self.holder.as_deref().and_then(|id| self.label(id))
    }
    fn label(&self, id: &str) -> Option<&str> {
        self.viewers
            .iter()
            .find(|v| v.0 == id)
            .map(|v| v.1.as_str())
    }
    pub fn size(&self) -> usize {
        self.viewers.len()
    }
    fn state(&mut self, id: &str, reason: Option<&str>) {
        let mut body = json!({"controller":self.holder(),"you":self.holder.as_deref()==Some(id)});
        if let Some(reason) = reason {
            body["reason"] = json!(reason);
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
        for (id, _) in self.viewers.clone() {
            self.state(&id, Some(reason));
        }
    }
    /// Caller has already validated and negotiated hello; returns false at capacity.
    pub fn join(&mut self, id: &str, label: &str) -> bool {
        if self.viewers.len() >= 16 || self.viewers.iter().any(|v| v.0 == id) {
            return false;
        }
        self.viewers.push((id.into(), label.into()));
        self.state(id, None);
        self.events.push(json!(["attach", label]));
        true
    }
    pub fn disconnect(&mut self, id: &str) {
        let joined = self.viewers.iter().any(|v| v.0 == id);
        let label = self.label(id).map(String::from);
        let was_holder = self.holder.as_deref() == Some(id);
        self.viewers.retain(|v| v.0 != id);
        if was_holder {
            self.holder = None;
            self.events.push(json!(["control-released", label]));
            for (peer, _) in self.viewers.clone() {
                self.state(&peer, Some("disconnected"));
            }
        }
        if joined {
            self.events.push(json!(["detach", label]));
        }
    }
    pub fn take(&mut self, id: &str, force: &Value) {
        if !self.viewers.iter().any(|v| v.0 == id) {
            return;
        }
        if self.holder.as_deref() == Some(id) {
            self.state(id, None);
        } else if self.holder.is_none() || force == &Value::Bool(true) {
            self.set(Some(id), "taken");
        } else {
            self.state(id, Some("refused"));
        }
    }
    pub fn release(&mut self, id: &str) {
        if self.holder.as_deref() == Some(id) {
            self.set(None, "released");
            self.events.push(json!(["release", self.label(id)]));
        }
    }
    pub fn input(&mut self, id: &str, bytes: &[u8]) -> bool {
        self.holder.as_deref() == Some(id) && !bytes.is_empty()
    }
    pub fn resize(&self, id: &str, cols: &Value, rows: &Value) -> Option<(u16, u16)> {
        if self.holder.as_deref() != Some(id) {
            return None;
        }
        Some((dimension(cols, 1000)?, dimension(rows, 500)?))
    }
}
fn dimension(v: &Value, max: u16) -> Option<u16> {
    let n = v.as_f64()?;
    (n >= 1.0 && n <= f64::from(max) && n.fract() == 0.0).then_some(n as u16)
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
