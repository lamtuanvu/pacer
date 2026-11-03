#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{PolicyPrivacy, allowed_planner_command, planner_environment};
use serde_json::json;
use std::collections::HashMap;

#[test]
fn protocol_number_parser_preserves_epoch_milliseconds_across_equivalent_spellings() {
    for micros in 0..10_000 {
        let expected = 1_793_600_000_000.0 + f64::from(micros) / 1_000_000.0;
        let spelling = format!("{expected:e}");
        let value: serde_json::Value = serde_json::from_str(&spelling).unwrap();
        assert_eq!(value.as_f64(), Some(expected), "{spelling}");
    }
}

#[test]
fn policy_mode_and_unreadable_legacy_grants_cannot_silently_open() {
    use pacer_plugin_host::{PluginsConfig, Registry};
    assert!(serde_json::from_value::<PluginsConfig>(json!({"policy":{"mode":"typo"}})).is_err());
    let config:PluginsConfig=serde_json::from_value(json!({"installed":{"legacy":{"version":"1.0.0","capabilities":[]},"explicit-nonpolicy":{"version":"1.0.0","capabilities":[],"policy":false},"disabled":{"version":"1.0.0","capabilities":[]}},"disabled":["disabled"]})).unwrap();
    assert_eq!(
        Registry::shadow().policy_unavailable(&config),
        vec![("legacy".into(), "plugin folder is missing".into())]
    );
}

#[test]
fn canonical_fingerprints_follow_js_number_and_key_enumeration_rules() {
    use pacer_plugin_host::js_canonical_json;
    assert_eq!(
        js_canonical_json(
            &json!({"10":1.0,"2":-0.0,"a":1e-7,"b":1e21,"😀":"astral","\u{e000}":"bmp"})
        )
        .unwrap(),
        "{\"2\":0,\"10\":1,\"a\":1e-7,\"b\":1e+21,\"😀\":\"astral\",\"\u{e000}\":\"bmp\"}"
    );
}

#[test]
fn planner_argv_and_environment_match_the_host_allowlist() {
    let launch = vec!["pacer".into(), "--profile".into(), "synthetic".into()];
    for args in [
        vec!["claude", "mcp", "get", "pacer"],
        vec!["claude", "mcp", "remove", "-s", "user", "pacer"],
    ] {
        assert!(allowed_planner_command(
            "claude",
            &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            &launch
        ));
    }
    for args in [
        vec!["claude", "mcp", "get", "other"],
        vec!["claude", "mcp", "get", "pacer", "--extra"],
        vec!["claude", "anything"],
    ] {
        assert!(!allowed_planner_command(
            "claude",
            &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            &launch
        ));
    }
    assert!(!allowed_planner_command(
        "codex",
        &["codex".into(), "mcp".into(), "get".into(), "pacer".into()],
        &launch
    ));
    let env = HashMap::from([
        ("HOME".into(), "/synthetic".into()),
        ("CODEX_HOME".into(), "/synthetic-codex".into()),
        ("UNRELATED_SECRET".into(), "hidden".into()),
    ]);
    let result = planner_environment(&env);
    assert_eq!(result.len(), 2);
    assert!(!result.contains_key("UNRELATED_SECRET"));
}

#[test]
fn redaction_is_plugin_keyed_uses_js_length_and_old_peers_omit_metadata() {
    let privacy = PolicyPrivacy::from_master([7; 32]);
    let input = json!({"decision":"delegate","input":{"goal":"a😀界","repo":"/synthetic/repo","kind":null,"requestedExecutor":null,"placement":"new"}});
    let a = privacy.redact("plugin-a", &input, false, true).unwrap();
    let b = privacy.redact("plugin-b", &input, false, true).unwrap();
    assert_eq!(a["input"]["goal"], "");
    assert_eq!(a["input"]["goalLength"], 4);
    assert_eq!(
        a["input"]["goalHash"],
        "094c25a6dddfcd13a50a9e54b707a2eafc0166c691e8ef11153478b072ae0f2c"
    );
    assert_ne!(a["input"]["goalHash"], b["input"]["goalHash"]);
    assert!(a["input"]["repo"].as_str().unwrap().starts_with("repo:"));
    assert_eq!(
        privacy.redact("plugin-a", &input, true, true).unwrap(),
        input
    );
    let old = privacy.redact("plugin-a", &input, false, false).unwrap();
    assert!(old["input"].get("goalHash").is_none());
    let review = json!({"decision":"review","input":{"taskId":"t-x","note":"a😀","verdict":"accept","revision":1,"state":"done"}});
    let redacted = privacy.redact("plugin-a", &review, false, true).unwrap();
    assert!(redacted["input"].get("note").is_none());
    assert_eq!(redacted["input"]["noteLength"], 3);
}

#[test]
fn key_is_private_stable_and_unsafe_existing_files_are_refused() {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };
    let root = std::env::temp_dir().join(format!("pacer-policy-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let input = json!({"decision":"delegate","input":{"goal":"secret","repo":"/synthetic"}});
    let a = PolicyPrivacy::load(&root)
        .unwrap()
        .redact("plugin-a", &input, false, true)
        .unwrap();
    let b = PolicyPrivacy::load(&root)
        .unwrap()
        .redact("plugin-a", &input, false, true)
        .unwrap();
    assert_eq!(a, b);
    assert_eq!(
        fs::metadata(root.join("state/policy-hmac.key"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    fs::set_permissions(
        root.join("state/policy-hmac.key"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(PolicyPrivacy::load(&root).is_err());
    fs::remove_file(root.join("state/policy-hmac.key")).unwrap();
    symlink(
        "/unreadable-synthetic-target",
        root.join("state/policy-hmac.key"),
    )
    .unwrap();
    assert!(PolicyPrivacy::load(&root).is_err());
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn credential_failure_is_sanitized_and_resolver_runs_once_even_after_rejection() {
    use pacer_plugin_host::{BrokerError, CredentialBindings};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let mut bindings = CredentialBindings::default();
    bindings
        .bind(
            "env:ISSUED",
            Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(BrokerError::Effect("sensitive callback detail".into())) })
            }),
        )
        .unwrap();
    for _ in 0..2 {
        let error = bindings
            .present("env:ISSUED")
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("sensitive"));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[test]
fn legacy_policy_strips_redaction_fields_even_when_present_in_original_input() {
    let privacy = pacer_plugin_host::PolicyPrivacy::from_master([1; 32]);
    let input = json!({"decision":"delegate","input":{"goal":"private","repo":"repo","goalLength":123,"goalHash":"x".repeat(64),"repoKey":"y".repeat(64)}});
    let wire = privacy.redact("legacy", &input, false, false).unwrap();
    for key in ["goalLength", "goalHash", "repoKey"] {
        assert!(wire["input"].get(key).is_none());
    }
}
#[tokio::test]
async fn policy_detail_requires_both_declaration_and_grant_and_key_is_lazy() {
    use pacer_plugin_host::{
        BrokerError, PolicyCaller, PolicyDetailAccess, PrivatePolicyCaller, parse_manifest,
    };
    use serde_json::Value;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };
    #[derive(Default)]
    struct Capture {
        seen: Vec<Value>,
    }
    impl PolicyCaller for Capture {
        async fn call(&mut self, _: &str, p: Value, _: Instant) -> Result<Value, BrokerError> {
            self.seen.push(p);
            Ok(json!({"verdict":"allow"}))
        }
    }
    for declared in [false, true] {
        for granted in [false, true] {
            for bundled in [false, true] {
                for metadata in [false, true] {
                    let home = std::env::temp_dir()
                        .join(format!("pacer-policy-detail-{}", uuid::Uuid::new_v4()));
                    fs::create_dir(&home).unwrap();
                    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
                    fs::write(home.join("secrets"), "CLASSIFIER_KEY=fixture\n").unwrap();
                    let manifest=parse_manifest(json!({"id":"policy-fixture","publisher":"test","version":"1.0.0","host":">=1.10.0","capabilities":if declared{json!([{"name":"tasks.read"}])}else{json!([])}})).unwrap();
                    let access = PolicyDetailAccess {
                        manifest,
                        granted: if granted {
                            vec!["tasks.read".into()]
                        } else {
                            vec![]
                        },
                        bundled,
                        redaction_metadata: metadata,
                    };
                    let mut caller = PrivatePolicyCaller::new(
                        &home,
                        Capture::default(),
                        HashMap::from([("policy-fixture".into(), access)]),
                    );
                    caller.call("policy-fixture",json!({"decision":"review","input":{"taskId":"t-fixture","revision":1,"state":"done","verdict":"accept"}}),Instant::now()+Duration::from_secs(1)).await.unwrap();
                    assert!(!home.join("state/policy-hmac.key").exists());
                    let raw = json!({"decision":"delegate","input":{"goal":"private😀","repo":"/synthetic/repo","kind":null,"requestedExecutor":null,"placement":"new"}});
                    caller
                        .call(
                            "policy-fixture",
                            raw.clone(),
                            Instant::now() + Duration::from_secs(1),
                        )
                        .await
                        .unwrap();
                    let seen = caller.caller.seen.last().unwrap();
                    let detail = declared && (granted || bundled);
                    if detail {
                        assert_eq!(*seen, raw);
                    } else {
                        assert_eq!(seen["input"]["goal"], "");
                        assert!(seen["input"]["repo"].as_str().unwrap().starts_with("repo:"));
                        assert_eq!(seen["input"].get("goalLength").is_some(), metadata);
                        if metadata {
                            assert_eq!(seen["input"]["goalLength"], 9);
                        }
                    }
                    assert_eq!(home.join("state/policy-hmac.key").exists(), !detail);
                    assert_eq!(
                        fs::read_to_string(home.join("secrets")).unwrap(),
                        "CLASSIFIER_KEY=fixture\n"
                    );
                    fs::remove_dir_all(home).unwrap();
                }
            }
        }
    }
}
