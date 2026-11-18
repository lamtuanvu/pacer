//! Bounded HTTP effect. The broker admits the destination before invoking this owner.
use crate::{AuthorityError, BrokerError, CredentialBindings};
use reqwest::{
    Client, Method,
    header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue},
};
use serde_json::{Value, json};
use std::{str::FromStr, time::Duration};

pub struct NativeHttp {
    client: Client,
    credentials: CredentialBindings,
}
fn invalid() -> BrokerError {
    BrokerError::Invalid("HTTP request or response exceeds its validated contract")
}
fn network() -> BrokerError {
    BrokerError::Effect("HTTP request failed".into())
}
fn reflection() -> BrokerError {
    AuthorityError::Denied("HTTP response exposed an injected credential".into()).into()
}
impl NativeHttp {
    pub(crate) fn has_binding(&self, reference: &str) -> bool {
        self.credentials.contains(reference)
    }
    pub fn new(credentials: CredentialBindings) -> Result<Self, BrokerError> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| network())?;
        Ok(Self {
            client,
            credentials,
        })
    }
    pub async fn secret_presence(&mut self, reference: &str) -> Result<Value, BrokerError> {
        Ok(json!({"present":self.credentials.present(reference).await?}))
    }
    pub fn revoke(&mut self) {
        self.credentials.revoke();
    }
    /// Call only with an origin admitted by CapabilityBroker; no RPC can create bindings.
    pub async fn request(&mut self, params: &Value) -> Result<Value, BrokerError> {
        let url = params["url"].as_str().ok_or_else(invalid)?;
        let method = params["method"]
            .as_str()
            .filter(|m| ["GET", "POST", "PUT", "DELETE"].contains(m))
            .ok_or_else(invalid)?;
        let ms = params
            .get("timeoutMs")
            .and_then(crate::js_semantics::safe_u64)
            .filter(|n| (1..=120_000).contains(n))
            .ok_or_else(invalid)?;
        let mut headers = HeaderMap::new();
        if let Some(input) = params.get("headers") {
            for (key, value) in input.as_object().ok_or_else(invalid)? {
                headers.append(
                    HeaderName::from_str(key).map_err(|_| invalid())?,
                    HeaderValue::from_str(value.as_str().ok_or_else(invalid)?)
                        .map_err(|_| invalid())?,
                );
            }
        }
        let body = params
            .get("body")
            .map(|v| {
                v.as_str()
                    .filter(|s| s.len() <= 4 * 1024 * 1024)
                    .ok_or_else(invalid)
            })
            .transpose()?;
        if ["GET"].contains(&method) && body.is_some() {
            return Err(invalid());
        }
        let mut injected = None;
        if let Some(auth) = params.get("authorization") {
            let reference = auth["secretRef"].as_str().ok_or_else(invalid)?;
            let scheme = auth
                .get("scheme")
                .map(|v| v.as_str().ok_or_else(invalid))
                .transpose()?
                .unwrap_or("Bearer");
            HeaderValue::from_str(&format!("{scheme} placeholder")).map_err(|_| invalid())?;
            let secret = self
                .credentials
                .resolve(reference)
                .await?
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("{scheme} {secret}")).map_err(|_| invalid())?,
            );
            injected = Some(secret);
        }
        let work = async {
            let mut request = self
                .client
                .request(
                    Method::from_bytes(method.as_bytes()).map_err(|_| invalid())?,
                    url,
                )
                .headers(headers);
            if let Some(body) = body {
                request = request.body(body.to_owned());
            }
            let mut response = request.send().await.map_err(|_| network())?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                return Err(AuthorityError::Denied("HTTP redirects are refused".into()).into());
            }
            let mut headers = serde_json::Map::new();
            for (name, value) in response.headers() {
                let value = value.to_str().map_err(|_| invalid())?;
                if injected
                    .as_ref()
                    .is_some_and(|s| name.as_str().contains(s) || value.contains(s))
                {
                    return Err(reflection());
                }
                headers
                    .entry(name.as_str().to_owned())
                    .and_modify(|old| {
                        if let Some(s) = old.as_str() {
                            *old = json!(format!("{s}, {value}"));
                        }
                    })
                    .or_insert_with(|| json!(value));
            }
            let metadata = json!({"status":status,"headers":headers,"body":""});
            if serde_json::to_vec(&metadata).map_err(|_| invalid())?.len() + 1
                > crate::MAX_LINE_BYTES
            {
                return Err(invalid());
            }
            let mut bytes = vec![];
            while let Some(chunk) = response.chunk().await.map_err(|_| network())? {
                if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                    return Err(invalid());
                }
                bytes.extend_from_slice(&chunk);
            }
            let body = String::from_utf8_lossy(&bytes);
            if body.len() > 4 * 1024 * 1024 {
                return Err(invalid());
            }
            if injected.as_ref().is_some_and(|s| body.contains(s)) {
                return Err(reflection());
            }
            Ok(json!({"status":status,"headers":headers,"body":body}))
        };
        tokio::time::timeout(Duration::from_millis(ms), work)
            .await
            .map_err(|_| BrokerError::Timeout)?
    }
}
