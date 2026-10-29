use super::RepairError;
use std::{
    io::Read,
    time::{Duration, Instant},
};
use url::Url;

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;

fn validate(url: &Url) -> Result<(), RepairError> {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1")))
    {
        return Err(RepairError::Invalid("release URL requires HTTPS (or literal 127.0.0.1 for tests), without credentials, query or fragment".into()));
    }
    Ok(())
}

pub(super) fn release_url(base: &str, version: &str, file: &str) -> Result<Url, RepairError> {
    if version.is_empty()
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    {
        return Err(RepairError::Invalid("invalid release version".into()));
    }
    let address = if base.is_empty() {
        format!("https://github.com/lamtuanvu/pacer/releases/download/v{version}/{file}")
    } else {
        format!("{}/{version}/{file}", base.trim_end_matches('/'))
    };
    let url = Url::parse(&address).map_err(|e| RepairError::Invalid(e.to_string()))?;
    validate(&url)?;
    if url.query().is_some() {
        return Err(RepairError::Invalid(
            "release base cannot contain a query".into(),
        ));
    }
    Ok(url)
}

pub(super) fn fetch(mut url: Url, cap: u64, deadline: Instant) -> Result<Vec<u8>, RepairError> {
    for _ in 0..=5 {
        validate(&url)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| *d > Duration::ZERO)
            .ok_or_else(|| RepairError::Invalid("release download timed out".into()))?;
        // Redirects are followed manually so every hop has the same URL policy and deadline.
        let agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .timeout_global(Some(remaining))
            .build()
            .new_agent();
        let mut response = agent
            .get(url.as_str())
            .call()
            .map_err(|e| RepairError::Download(e.to_string()))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| RepairError::Invalid("release redirect has no location".into()))?;
            let next = url
                .join(location)
                .map_err(|e| RepairError::Invalid(e.to_string()))?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err(RepairError::Invalid(
                    "release redirect downgrades HTTPS".into(),
                ));
            }
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(RepairError::Invalid("release download failed".into()));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(cap + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > cap {
            return Err(RepairError::Invalid(
                "release download exceeds size limit".into(),
            ));
        }
        return Ok(bytes);
    }
    Err(RepairError::Invalid("too many release redirects".into()))
}
