//! Host-only lazy credential bindings. References cannot fall back to ambient state.
use crate::{AuthorityError, BrokerError};
use std::{collections::HashMap, future::Future, pin::Pin};
type Lookup = Box<
    dyn FnMut() -> Pin<Box<dyn Future<Output = Result<Option<String>, BrokerError>> + Send>> + Send,
>;
struct Binding {
    lookup: Lookup,
    cached: Option<Option<Vec<u8>>>,
    started: bool,
}
impl Drop for Binding {
    fn drop(&mut self) {
        if let Some(Some(bytes)) = &mut self.cached {
            bytes.fill(0);
        }
    }
}
#[derive(Default)]
pub struct CredentialBindings {
    bindings: HashMap<String, Binding>,
}
impl CredentialBindings {
    pub fn contains(&self, reference: &str) -> bool {
        self.bindings.contains_key(reference)
    }
    pub fn bind(&mut self, reference: &str, lookup: Lookup) -> Result<(), BrokerError> {
        if !valid_reference(reference) || self.bindings.contains_key(reference) {
            return Err(BrokerError::Invalid("credential binding"));
        }
        self.bindings.insert(
            reference.into(),
            Binding {
                lookup,
                cached: None,
                started: false,
            },
        );
        Ok(())
    }
    pub fn bind_value(
        &mut self,
        reference: &str,
        value: Option<String>,
    ) -> Result<(), BrokerError> {
        let mut value = value;
        self.bind(
            reference,
            Box::new(move || {
                let value = value.take();
                Box::pin(async move { Ok(value) })
            }),
        )
    }
    pub async fn resolve(&mut self, reference: &str) -> Result<Option<String>, BrokerError> {
        if !valid_reference(reference) {
            return Err(BrokerError::Invalid("secret reference"));
        }
        let binding = self.bindings.get_mut(reference).ok_or_else(|| {
            AuthorityError::Denied("credential reference is not bound to this call".into())
        })?;
        if binding.cached.is_none() {
            if binding.started {
                return Err(AuthorityError::Denied(
                    "bound credential could not be resolved".into(),
                )
                .into());
            }
            binding.started = true;
            let value = (binding.lookup)().await.map_err(|_| {
                AuthorityError::Denied("bound credential could not be resolved".into())
            })?;
            binding.cached = Some(value.map(String::into_bytes));
        }
        Ok(binding
            .cached
            .as_ref()
            .and_then(|v| v.as_ref())
            .map(|v| String::from_utf8_lossy(v).into_owned()))
    }
    pub async fn present(&mut self, reference: &str) -> Result<bool, BrokerError> {
        Ok(self.resolve(reference).await?.is_some())
    }
    pub fn revoke(&mut self) {
        self.bindings.clear();
    }
}
pub fn valid_reference(value: &str) -> bool {
    if let Some(name) = value.strip_prefix("endpoint/") {
        return name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    }
    let Some((kind, name)) = value.split_once(':') else {
        return false;
    };
    ["env", "secrets", "endpoint"].contains(&kind)
        && name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
