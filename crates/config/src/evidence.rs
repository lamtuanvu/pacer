//! The account evidence identity: the key of the stored evidence files under
//! `state/evidence/`. One implementation, shared by every surface that reads or
//! retires stored evidence; it matches TypeScript's
//! `accountEvidenceScope(account, hosts).identity` (`src/evidence/scope.ts`)
//! byte for byte.
use pacer_js_json::{js_semantics::locale_compare, stringify};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// `accountEvidenceScope(account, hosts).identity`. Host aliases sort with the
/// locale compare TypeScript uses, and the provider enters the signature only
/// when JavaScript calls it truthy, so one account has one identity everywhere.
pub fn evidence_identity(account: &Value, hosts: &Value) -> String {
    let name = account["name"].as_str().unwrap_or("");
    let mut aliases: Vec<_> = hosts.as_object().into_iter().flatten().collect();
    aliases.sort_by(|a, b| locale_compare(a.0, b.0));
    let hosts: Vec<Value> = aliases
        .into_iter()
        .map(|(alias, host)| {
            let home = host["accounts"]
                .as_object()
                .and_then(|accounts| accounts.get(name))
                .map_or(Value::Null, |a| a["home"].clone());
            json!([alias, host["ssh"], home])
        })
        .collect();
    let mut signature = vec![
        account["name"].clone(),
        account["kind"].clone(),
        account["source"].clone(),
        account["home"].clone(),
        account["orcaAccount"].clone(),
        account["usageSource"].clone(),
        account["quotaSource"].clone(),
        account["connection"]["base_url"].clone(),
        account["connection"]["key"].clone(),
        Value::Array(hosts),
    ];
    if pacer_js_json::js_semantics::truthy(&account["provider"]) {
        signature.push(account["provider"].clone());
    }
    format!(
        "{:x}",
        Sha256::digest(stringify(&Value::Array(signature)).as_bytes())
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::evidence_identity;
    use serde_json::{Value, json};

    /// Golden values computed with the TypeScript `accountEvidenceScope`.
    /// Mixed-case aliases ("Alpha", "box", "Mac") sort differently under the
    /// locale compare the identity uses than by bytes, and the provider enters
    /// the signature only when JavaScript calls it truthy.
    #[test]
    fn evidence_identity_matches_typescript() {
        let hosts = json!({
            "Mac": {"ssh": null, "accounts": {}},
            "box": {"ssh": "box.example.com", "accounts": {"work": {"home": "/home/dev/.claude"}}},
            "Alpha": {"ssh": null, "accounts": {}},
        });
        let identity = |provider: Value| {
            evidence_identity(
                &json!({
                    "name": "work", "kind": "claude", "source": "native", "home": "/Users/dev/.claude",
                    "orcaAccount": null, "usageSource": null, "quotaSource": null,
                    "connection": {"base_url": null, "key": null}, "provider": provider,
                }),
                &hosts,
            )
        };
        assert_eq!(
            identity(json!("anthropic")),
            "10ef1653f10e368fba3d223d2e9effdde6cf9dba70866644c232206843f50a4f"
        );
        assert_eq!(
            identity(json!(1)),
            "2bb7d11ab9814d2bcab7ca0da441e7cdc7ccedf247f8d14c9e2134747f1380ef"
        );
        assert_eq!(
            identity(json!(true)),
            "d166dd7237919dc6e3059b4c87cf308d9c4dc7c8ddb65869bced517da3f12bdf"
        );
        // Falsy providers ("" and missing alike) leave the signature unchanged.
        assert_eq!(
            identity(json!("")),
            "42015eabcbe8c0f7b9000ca499fe5d4e476bbe3eacab95bb0c3651b18493439f"
        );
        assert_eq!(
            evidence_identity(
                &json!({
                    "name": "work", "kind": "claude", "source": "native", "home": "/Users/dev/.claude",
                    "orcaAccount": null, "usageSource": null, "quotaSource": null,
                    "connection": {"base_url": null, "key": null},
                }),
                &hosts,
            ),
            "42015eabcbe8c0f7b9000ca499fe5d4e476bbe3eacab95bb0c3651b18493439f"
        );
    }
}
