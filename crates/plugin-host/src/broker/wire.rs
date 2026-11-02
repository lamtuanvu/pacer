use super::*;
use crate::WireReply;
struct WireEffect<'a, E> {
    effect: &'a mut E,
    reply: Option<WireReply>,
}
impl<E: CapabilityEffect> CapabilityEffect for WireEffect<'_, E> {
    async fn retire(&mut self) -> Result<(), BrokerError> {
        self.effect.retire().await
    }
    fn owns_lifecycle(&self, m: &str, p: &str, s: &[String]) -> bool {
        self.effect.owns_lifecycle(m, p, s)
    }
    async fn call(&mut self, m: &str, p: Value) -> Result<Value, BrokerError> {
        let reply = self.effect.call_wire(m, p).await?;
        let preview = reply.preview().clone();
        self.reply = Some(reply);
        Ok(preview)
    }
}
impl CapabilityBroker {
    /// Orca replies may contain a JS slice's lone surrogate. The existing Value
    /// API is scalar-only; wire delivery retains the exact UTF-16 JSON string.
    pub async fn handle_wire<E: CapabilityEffect>(
        &mut self,
        method: &str,
        params: Value,
        effect: &mut E,
    ) -> Result<WireReply, BrokerError> {
        if !method.starts_with("capability.orca.") {
            return Err(BrokerError::Invalid("lossless wire method"));
        }
        let mut adapter = WireEffect {
            effect,
            reply: None,
        };
        let value = self.handle(method, params, &mut adapter).await?;
        let reply = adapter.reply.unwrap_or_else(|| WireReply::new(value));
        let json = reply
            .to_json()
            .map_err(|_| BrokerError::Invalid("wire result"))?;
        self.authority.active()?;
        if json.len() + 1 > crate::MAX_LINE_BYTES {
            return Err(BrokerError::Invalid("wire response envelope"));
        }
        Ok(reply)
    }
}
