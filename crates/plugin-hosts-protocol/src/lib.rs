//! Generated host-runner and host capability wire types.
mod generated;
pub use generated::*;

#[cfg(test)]
mod tests {
    use super::HostRunnerUploadParams;

    #[test]
    fn valid_binary_upload_params_round_trip() {
        let hash = "a".repeat(64);
        let raw = serde_json::json!({
            "session": "s".repeat(32),
            "script": "BINARY",
            "args": [hash, "upload"],
            "timeoutMs": 300_000,
            "maxBytes": 4096,
            "completionNonce": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
        });
        let params: HostRunnerUploadParams = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), raw);
    }
}
