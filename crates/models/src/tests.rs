#![allow(clippy::unwrap_used)]
use crate::*;
use serde_json::{Value, json};
use std::{fs, path::Path};

const NOW: f64 = 1_700_000_000.5;

fn strategy() -> Value {
    json!({
        "planner": {"agent": "claude-code", "account": "claude"},
        "accounts": {
            "claude": {"name": "claude", "kind": "claude", "source": "default", "provider": null, "home": null, "orcaAccount": null},
            "codex": {"name": "codex", "kind": "codex", "source": "default", "provider": null, "home": null, "orcaAccount": null},
            "oc": {"name": "oc", "kind": "endpoint", "source": "opencode", "provider": "acme", "home": null, "orcaAccount": null},
            "named": {"name": "named", "kind": "endpoint", "source": "endpoint", "provider": "vendor", "home": null, "orcaAccount": null,
                "connection": {"models": [{"id": "a"}, {"id": "b"}]}},
            "acct": {"name": "acct", "kind": "endpoint", "source": "endpoint", "provider": null, "home": null, "orcaAccount": null,
                "connection": {"models": [{"id": "xa"}, {"id": "x😁"}, {"id": "y"}, {"id": "xab"}]}},
            "empty": {"name": "empty", "kind": "endpoint", "source": "endpoint", "provider": null, "home": null, "orcaAccount": null,
                "connection": {"models": []}},
        },
        "runners": {
            "claude-code": {"id": "claude-code", "agent": "claude-code", "account": "claude", "host": null},
            "codex": {"id": "codex", "agent": "codex", "account": "codex", "host": null},
            "opencode#oc": {"id": "opencode#oc", "agent": "opencode", "account": "oc", "host": null},
            "opencode#named": {"id": "opencode#named", "agent": "opencode", "account": "named", "host": null},
            "opencode#acct": {"id": "opencode#acct", "agent": "opencode", "account": "acct", "host": null},
            "opencode#empty": {"id": "opencode#empty", "agent": "opencode", "account": "empty", "host": null},
            "opencode#ghost": {"id": "opencode#ghost", "agent": "opencode", "account": "ghost", "host": null},
        },
        "runnerAliases": {"fast": "opencode#acct"},
    })
}

fn seed(home: &Path, runner: &str, text: &str) {
    let path = cache_file(home, runner);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn cache(models: Value, fetched_at: f64) -> String {
    json!({"runner": "opencode#oc", "source": "opencode", "models": models, "fetchedAt": fetched_at, "provider": "acme"})
        .to_string()
}

fn ids(listing: &Listing) -> Option<Vec<&str>> {
    match listing {
        Listing::Known(list) => list
            .models
            .as_ref()
            .map(|m| m.iter().map(|m| m.id.as_str()).collect()),
        other => panic!("not a known listing: {other:?}"),
    }
}

#[test]
fn cache_path_hashes_the_runner_id() {
    assert_eq!(
        cache_file(Path::new("/h"), "opencode#oc"),
        Path::new(
            "/h/cache/available-models/fecf0a7a1895be972d3f0350c599e98883208783d9a25891eff13e6039665889.json"
        )
    );
}

#[test]
fn opencode_accounts_need_discovery_without_a_fresh_cache() {
    let dir = tempfile::tempdir().unwrap();
    let s = strategy();
    assert_eq!(
        available_models(dir.path(), NOW, &s, "opencode#oc"),
        Listing::NeedsDiscovery
    );
    for (text, why) in [
        (
            cache(json!([{"id": "acme/a"}]), NOW - CACHE_TTL_S),
            "stale at the TTL",
        ),
        (
            r#"{"runner":"opencode#oc","source":"opencode","models":[],"fetchedAt":-1e400}"#.into(),
            "stale forever",
        ),
        (
            r#"{"runner":"opencode#oc","source":"connection","models":[],"fetchedAt":1700000000}"#
                .into(),
            "never served",
        ),
        (
            r#"{"runner":"opencode#oc","source":"opencode","fetchedAt":1700000000}"#.into(),
            "models missing",
        ),
        (
            r#"{"runner":"opencode#oc","source":"opencode","models":{},"fetchedAt":1700000000}"#
                .into(),
            "models object",
        ),
        (
            r#"{"runner":1,"source":"opencode","models":[],"fetchedAt":1700000000}"#.into(),
            "runner number",
        ),
        (
            r#"{"runner":1e400,"source":"opencode","models":[],"fetchedAt":1700000000}"#.into(),
            "runner Infinity",
        ),
        (
            r#"{"runner":"r","source":"opencode","models":[],"fetchedAt":"1700000000"}"#.into(),
            "fetchedAt string",
        ),
        (
            r#"{"runner":"r","source":"other","models":[],"fetchedAt":1700000000}"#.into(),
            "unknown source",
        ),
        ("[]".into(), "array"),
        ("{".into(), "invalid JSON"),
        ("\u{feff}{}".into(), "byte order mark"),
    ] {
        seed(dir.path(), "opencode#oc", &text);
        let got = available_models(dir.path(), NOW, &s, "opencode#oc");
        assert_eq!(got, Listing::NeedsDiscovery, "{why}: {text}");
    }
    fs::remove_file(cache_file(dir.path(), "opencode#oc")).unwrap();
    fs::create_dir(cache_file(dir.path(), "opencode#oc")).unwrap();
    assert_eq!(
        available_models(dir.path(), NOW, &s, "opencode#oc"),
        Listing::NeedsDiscovery
    );
}

#[test]
fn a_fresh_cache_is_served_whatever_the_account_is() {
    let dir = tempfile::tempdir().unwrap();
    let s = strategy();
    seed(
        dir.path(),
        "opencode#oc",
        &cache(
            json!([{"id": "acme/a", "name": "A"}, {"id": "acme/b"}]),
            NOW - 599.0,
        ),
    );
    let Listing::Known(list) = available_models(dir.path(), NOW, &s, "opencode#oc") else {
        panic!("fresh cache missed");
    };
    assert_eq!(list.source, ModelSource::Opencode);
    assert_eq!(list.provider.as_deref(), Some("acme"));
    assert_eq!(ids(&Listing::Known(list)), Some(vec!["acme/a", "acme/b"]));
    // A connection runner's cached OpenCode listing wins over its declared models.
    seed(
        dir.path(),
        "opencode#named",
        &cache(json!([{"id": "cached"}]), NOW),
    );
    assert_eq!(
        ids(&available_models(dir.path(), NOW, &s, "opencode#named")),
        Some(vec!["cached"])
    );
    // 1e400 parses as Infinity, a number: fresh forever.
    seed(
        dir.path(),
        "codex",
        r#"{"runner":"x","source":"opencode","models":null,"fetchedAt":1e400,"note":"n"}"#,
    );
    let Listing::Known(list) = available_models(dir.path(), NOW, &s, "codex") else {
        panic!("infinite fetchedAt missed");
    };
    assert_eq!((list.models, list.note.as_deref()), (None, Some("n")));
}

#[test]
fn cache_values_typescript_would_mishandle_stay_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let s = strategy();
    for models in [
        json!([null]),
        json!(["acme/a"]),
        json!([{"id": 1}]),
        json!([{"name": "no id"}]),
        json!([[]]),
        json!([{"id": "acme/a"}, 5]),
    ] {
        seed(dir.path(), "codex", &cache(models.clone(), NOW));
        assert_eq!(
            available_models(dir.path(), NOW, &s, "codex"),
            Listing::Unsupported,
            "{models}"
        );
    }
    seed(
        dir.path(),
        "codex",
        r#"{"runner":"r","source":"opencode","models":[{"id":"\ud800"}],"fetchedAt":1700000000}"#,
    );
    assert_eq!(
        available_models(dir.path(), NOW, &s, "codex"),
        Listing::Unsupported
    );
    for note in ["1", "{}", "[\"a\"]", "\"\\udc00\""] {
        seed(
            dir.path(),
            "codex",
            &format!(
                r#"{{"runner":"r","source":"opencode","models":null,"fetchedAt":1700000000,"note":{note}}}"#
            ),
        );
        assert_eq!(
            available_models(dir.path(), NOW, &s, "codex"),
            Listing::Unsupported,
            "{note}"
        );
    }
    // With models listed, the note is never read.
    seed(
        dir.path(),
        "codex",
        r#"{"runner":"r","source":"opencode","models":[],"fetchedAt":1700000000,"note":5}"#,
    );
    assert_eq!(
        ids(&available_models(dir.path(), NOW, &s, "codex")),
        Some(vec![])
    );
    let deep = format!("{}{}", "[".repeat(600), "]".repeat(600));
    seed(
        dir.path(),
        "codex",
        &format!(
            r#"{{"runner":"r","source":"opencode","models":[],"fetchedAt":1700000000,"x":{deep}}}"#
        ),
    );
    assert_eq!(
        available_models(dir.path(), NOW, &s, "codex"),
        Listing::Unsupported
    );
}

#[test]
fn connection_and_sourceless_runners_list_from_the_strategy() {
    let dir = tempfile::tempdir().unwrap();
    let s = strategy();
    assert_eq!(
        ids(&available_models(dir.path(), NOW, &s, "opencode#named")),
        Some(vec!["pacer-named/a", "pacer-named/b"])
    );
    let Listing::Known(empty) = available_models(dir.path(), NOW, &s, "opencode#empty") else {
        panic!("empty connection");
    };
    assert_eq!(empty.source, ModelSource::Connection);
    assert_eq!(empty.models, None);
    assert_eq!(empty.note.as_deref(), Some("empty declares no models"));
    for runner in ["codex", "opencode#ghost", "missing"] {
        let Listing::Known(list) = available_models(dir.path(), NOW, &s, runner) else {
            panic!("{runner}");
        };
        assert_eq!(
            (list.source, list.models),
            (ModelSource::None, None),
            "{runner}"
        );
    }
    // A stale cache for a connection runner falls back to its declared models.
    seed(
        dir.path(),
        "opencode#named",
        &cache(json!([{"id": "old"}]), NOW - 601.0),
    );
    assert_eq!(
        ids(&available_models(dir.path(), NOW, &s, "opencode#named")),
        Some(vec!["pacer-named/a", "pacer-named/b"])
    );
}

#[test]
fn closest_models_rank_by_utf16_prefix_then_distance() {
    let list = |ids: &[&str]| AvailableModels {
        runner: "r".into(),
        source: ModelSource::Connection,
        models: Some(
            ids.iter()
                .map(|id| AvailableModel { id: (*id).into() })
                .collect(),
        ),
        fetched_at: NOW,
        note: None,
        provider: None,
    };
    // 😀 and 😁 share their high surrogate: two shared code units, one edit.
    assert_eq!(
        closest_models(&list(&["xa", "x😁", "y"]), "x😀", 3),
        vec!["x😁", "xa", "y"]
    );
    assert_eq!(
        closest_models(&list(&["abd", "abc", "abcd", "zz", "ab"]), "abx", 3),
        vec!["abd", "abc", "ab"]
    );
    assert_eq!(
        closest_models(&list(&["b2", "b1", "a"]), "c", 3),
        vec!["a", "b2", "b1"]
    );
    assert_eq!(
        closest_models(&list(&["same"]), "same", 3),
        Vec::<String>::new()
    );
    assert_eq!(is_offered(&list(&["same"]), "same"), Some(true));
    assert_eq!(is_offered(&list(&["same"]), "other"), Some(false));
}

#[test]
fn validation_follows_the_runner_set_order() {
    let dir = tempfile::tempdir().unwrap();
    let s = strategy();
    let check =
        |runner: &str, model: &str| validate_runner_model(dir.path(), NOW, &s, runner, model);
    assert_eq!(check("missing", "m"), Validation::NotReached);
    assert_eq!(check("claude-code", "m"), Validation::NotReached);
    assert_eq!(check("codex", "anything"), Validation::Accepted(None));
    assert_eq!(check("opencode#oc", "acme/a"), Validation::NeedsCore);
    assert_eq!(check("fast", "pacer-acct/y"), Validation::Accepted(None));
    assert_eq!(
        check("fast", "pacer-acct/x😀"),
        Validation::Refused {
            message: "pacer-acct/x😀 is not offered by acct".into(),
            hint: Some("Available: pacer-acct/x😁, pacer-acct/xa, pacer-acct/xab".into()),
        }
    );
    assert_eq!(
        check("opencode#named", "nope"),
        Validation::Refused {
            message: "nope is not offered by vendor".into(),
            hint: Some("Available: pacer-named/a, pacer-named/b".into()),
        }
    );
    assert_eq!(
        check("opencode#empty", "pacer-empty/a"),
        Validation::Accepted(Some(
            "pacer-empty/a could not be checked: empty declares no models".into()
        ))
    );
    seed(dir.path(), "opencode#oc", &cache(json!([]), NOW));
    assert_eq!(
        check("opencode#oc", "acme/a"),
        Validation::Refused {
            message: "acme/a is not offered by acme".into(),
            hint: None
        }
    );
    seed(
        dir.path(),
        "opencode#oc",
        r#"{"runner":"opencode#oc","source":"opencode","models":null,"fetchedAt":1700000000}"#,
    );
    assert_eq!(
        check("opencode#oc", "acme/a"),
        Validation::Accepted(Some("acme/a could not be checked: ".into()))
    );
    seed(dir.path(), "opencode#oc", &cache(json!([null]), NOW));
    assert_eq!(check("opencode#oc", "acme/a"), Validation::NeedsCore);
}

#[test]
fn declarations_report_zod_issues_in_schema_order() {
    let parse = |value: Value| {
        let mut issues = Vec::new();
        let out = declarations::model_declarations(Some(&value), "models", &mut issues);
        (out, issues.join("; "))
    };
    assert_eq!(
        parse(json!([{"id": "", "tier": "huge", "strengths": [""], "tools": 1, "context": -1.5, "x": 1}, 7])).1,
        "models.0.id: Too small: expected string to have >=1 characters; models.0.tier: Invalid option: expected one of \"small\"|\"medium\"|\"frontier\"|\"unknown\"; models.0.strengths.0: Too small: expected string to have >=1 characters; models.0.tools: Invalid input: expected boolean, received number; models.0.context: Invalid input: expected int, received number; models.0: Unrecognized key: \"x\"; models.1: Invalid input: expected object, received number"
    );
    assert_eq!(
        parse(
            json!([{"id": "a", "context": 1e300}, {"id": "b", "context": -1e300, "y": 1, "z": 2}])
        )
        .1,
        "models.0.context: Too big: expected int to be <=9007199254740991; models.1.context: Too small: expected int to be >=-9007199254740991; models.1.context: Too small: expected number to be >0; models.1: Unrecognized keys: \"y\", \"z\""
    );
    assert_eq!(
        parse(json!("x")).1,
        "models: Invalid input: expected array, received string"
    );
    let (out, issues) =
        parse(json!([{"context": 5, "tools": false, "tier": "frontier", "id": "m"}, {"id": "n"}]));
    assert_eq!(issues, "");
    assert_eq!(
        serde_json::to_string(&out).unwrap(),
        r#"[{"id":"m","tier":"frontier","strengths":[],"tools":false,"context":5},{"id":"n","tier":"unknown","strengths":[]}]"#
    );
}

#[test]
fn runner_models_validation_matches_validate_runner_models() {
    let listing = |ids: &[&str]| AvailableModels {
        runner: "r".into(),
        source: ModelSource::Connection,
        models: Some(
            ids.iter()
                .map(|id| AvailableModel { id: (*id).into() })
                .collect(),
        ),
        fetched_at: NOW,
        note: None,
        provider: None,
    };
    let known = listing(&["a", "b", "ab"]);
    let declare = |ids: &[(&str, &[&str])]| -> Vec<Value> {
        ids.iter()
            .map(|(id, strengths)| json!({"id": id, "tier": "small", "strengths": strengths}))
            .collect()
    };
    let mut warnings = Vec::new();
    let models = validate_runner_models(
        "acme",
        &known,
        "b",
        &declare(&[("a", &["x"]), ("b", &[])]),
        &mut warnings,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&models).unwrap(),
        r#"[{"id":"a","tier":"small","strengths":["x"]},{"id":"b","tier":"small"}]"#
    );
    let refuse = |default: &str, models: &[(&str, &[&str])]| {
        validate_runner_models("acme", &known, default, &declare(models), &mut Vec::new())
            .unwrap_err()
    };
    assert_eq!(
        refuse("a", &[("a", &[]), ("a", &[])]).message,
        "duplicate models"
    );
    assert_eq!(
        refuse("c", &[("a", &[]), ("b", &[])]).message,
        "default must be one of models: a, b"
    );
    assert_eq!(
        refuse("a", &[("a", &[]), ("zz", &[])]),
        Refusal {
            message: "zz is not offered by acme".into(),
            hint: Some("Available: a, b, ab".into())
        }
    );
    assert_eq!(refuse("zz", &[]).message, "zz is not offered by acme");
    let unknown = AvailableModels {
        models: None,
        note: Some("no list".into()),
        ..listing(&[])
    };
    let mut warnings = Vec::new();
    validate_runner_models("acme", &unknown, "q", &[], &mut warnings).unwrap();
    assert_eq!(warnings, ["q could not be checked: no list"]);
    assert_eq!(
        model_declaration_warnings(
            &json!({"id": "r", "model": "x", "models": [{"id": "a", "tier": "unknown"}]})
        ),
        [
            "runners.r: default model \"x\" is not in models",
            "runners.r: model \"a\" is unrated (tier unknown)"
        ]
    );
}
