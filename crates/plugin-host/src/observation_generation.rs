//! Registry-owned observation admission, separate from effect authority.
use crate::{
    AuthorityError, BrokerError, EventSubscription, ParsedManifest, ReadContext, ReadOwner,
    TaskProjection, read_task,
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc, time::Instant};
pub struct ObservationCall {
    token: String,
    deadline: Instant,
    grants: HashSet<String>,
    pub bootstrap: bool,
    revoked: bool,
}
impl ObservationCall {
    pub fn new(token: String, deadline: Instant, grants: Vec<String>, bootstrap: bool) -> Self {
        Self {
            token,
            deadline,
            grants: grants.into_iter().collect(),
            bootstrap,
            revoked: false,
        }
    }
    pub fn revoke(&mut self) {
        self.revoked = true;
    }
    fn granted(&self, capability: &str) -> Result<(), BrokerError> {
        if self.revoked || Instant::now() >= self.deadline || !self.grants.contains(capability) {
            return Err(denied());
        }
        Ok(())
    }
}
fn denied() -> BrokerError {
    AuthorityError::Denied("observation owner or transport was not issued".into()).into()
}
pub struct ObservationGeneration {
    context: ReadContext,
    manifest: ParsedManifest,
    grants: Vec<String>,
    negotiated: bool,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
    owner: Option<ReadOwner>,
    subscription: Option<EventSubscription>,
}
impl ObservationGeneration {
    pub fn new(
        context: ReadContext,
        manifest: ParsedManifest,
        grants: Vec<String>,
        negotiated: bool,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self {
            context,
            manifest,
            grants,
            negotiated,
            current,
            owner: None,
            subscription: None,
        }
    }
    pub fn retire(&mut self) {
        if let Some(owner) = &self.owner {
            owner.revoke();
        }
        if let Some(subscription) = &mut self.subscription {
            subscription.retire(true);
        }
        self.owner = None;
        self.subscription = None;
    }
    pub fn authorize(
        &self,
        method: &str,
        request: &Value,
        call: Option<&ObservationCall>,
    ) -> Result<(), BrokerError> {
        if !self.negotiated || !(self.current)() {
            return Err(denied());
        }
        let capability = match method {
            "capability.tasks.read" | "capability.tasks.list" => "tasks.read",
            "capability.events.subscribe" => "events.subscribe",
            _ => return Err(denied()),
        };
        if !self
            .manifest
            .capabilities
            .iter()
            .any(|c| c.name.to_string() == capability)
        {
            return Err(denied());
        }
        let meta = request
            .get("_meta")
            .and_then(Value::as_object)
            .ok_or_else(denied)?;
        if meta.contains_key("readOwner") && meta.contains_key("capabilityCall") {
            return Err(denied());
        }
        if meta.contains_key("readOwner") {
            return self
                .owner
                .as_ref()
                .ok_or_else(denied)?
                .admit(method, &Value::Object(meta.clone()));
        }
        let call = call.ok_or_else(denied)?;
        if meta.get("capabilityCall").and_then(Value::as_str) != Some(&call.token) {
            return Err(denied());
        }
        call.granted(capability)
    }
    pub fn subscribe(
        &mut self,
        params: &Value,
        request: &Value,
        call: Option<&ObservationCall>,
        cursor: u64,
    ) -> Result<Value, BrokerError> {
        self.authorize("capability.events.subscribe", request, call)?;
        if request.pointer("/_meta/capabilityCall").is_some() && !call.is_some_and(|c| c.bootstrap)
        {
            return Err(denied());
        }
        let types: Vec<String> = serde_json::from_value(params["types"].clone())
            .map_err(|_| BrokerError::Invalid("subscription types"))?;
        if params.as_object().is_none_or(|o| o.len() != 1) {
            return Err(BrokerError::Invalid("subscription types"));
        }
        let owner = match &self.owner {
            Some(owner) => owner.clone(),
            None => ReadOwner::new(
                self.context.clone(),
                &self.manifest,
                &self.grants,
                self.current.clone(),
            )?,
        };
        let reply = json!({"ok":true,"readOwner":owner.token()});
        let envelope = json!({"jsonrpc":"2.0","id":request["id"],"result":reply});
        crate::frame(envelope).map_err(|_| {
            BrokerError::Invalid("subscription acknowledgement exceeds transport frame")
        })?;
        let subscription = EventSubscription::new(owner.clone(), &types, cursor)?;
        if let Some(old) = &mut self.subscription {
            old.retire(false);
        }
        self.owner = Some(owner);
        self.subscription = Some(subscription);
        Ok(reply)
    }
    pub fn subscription(&mut self) -> Option<&mut EventSubscription> {
        self.subscription.as_mut()
    }
    pub async fn read<P: TaskProjection>(
        &mut self,
        method: &str,
        params: Value,
        request: &Value,
        call: Option<&ObservationCall>,
        projection: &mut P,
    ) -> Result<Value, BrokerError> {
        self.authorize(method, request, call)?;
        let owner = if request.pointer("/_meta/readOwner").is_some() {
            self.owner.clone().ok_or_else(denied)?
        } else {
            let call = call.ok_or_else(denied)?;
            let grants: Vec<_> = call.grants.iter().cloned().collect();
            let current = self.current.clone();
            ReadOwner::new(self.context.clone(), &self.manifest, &grants, current)?
        };
        let result = read_task(
            &owner,
            &self.context.home,
            &self.context.pacer_home,
            method,
            params,
            request,
            projection,
        )
        .await?;
        self.authorize(method, request, call)?;
        Ok(result)
    }
}
impl Drop for ObservationGeneration {
    fn drop(&mut self) {
        self.retire();
    }
}
