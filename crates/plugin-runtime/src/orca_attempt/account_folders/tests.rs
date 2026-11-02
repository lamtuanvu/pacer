#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn raw_value_top_level_tokens_validate_ignored_json_without_scalar_or_depth_limits() {
    use serde::{
        Deserialize, Deserializer,
        de::{MapAccess, Visitor},
    };
    use serde_json::value::RawValue;
    struct Tokens;
    impl<'de> Deserialize<'de> for Tokens {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Tokens;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("object")
                }
                fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<Tokens, M::Error> {
                    while let Some(key) = m.next_key::<Box<RawValue>>()? {
                        assert!(key.get().starts_with('"'));
                        let _ = m.next_value::<Box<RawValue>>()?;
                    }
                    Ok(Tokens)
                }
            }
            d.deserialize_map(V)
        }
    }
    let deep = format!("{}0{}", "[".repeat(1000), "]".repeat(1000));
    for text in [
        r#"{"claude":"/keep","\ud800":0,"foreign":"\udfff"}"#.to_string(),
        r#"{"codex":"/keep","foreign":1e99999}"#.into(),
        format!("{{\"claude\":\"/keep\",\"foreign\":{deep}}}"),
    ] {
        assert!(serde_json::from_str::<Box<RawValue>>(&text).is_ok());
        assert!(serde_json::from_str::<Tokens>(&text).is_ok(), "{text}");
    }
    for text in [
        r#"{"codex":"/keep"}garbage"#,
        r#"{"foreign":[}"#,
        r#"{"foreign":1e+}"#,
        r#"{"foreign":"\uZZZZ"}"#,
    ] {
        assert!(serde_json::from_str::<Box<RawValue>>(text).is_err());
    }
}

#[test]
fn default_folder_records_match_actual_ts_exact_bytes_and_noop_metadata() {
    use std::{
        fs,
        io::Write,
        os::unix::fs::{MetadataExt, PermissionsExt},
        process::{Command, Stdio},
    };
    let deep = format!("{}0{}", "[".repeat(1000), "]".repeat(1000));
    let mut sources: Vec<Option<Vec<u8>>> = [
        "",
        "not json",
        "[]",
        "null",
        "7",
        "\"/scalar\"",
        "{}",
        r#"{"claude":"/claude","codex":"/codex","foreign":true}"#,
        r#"{ "codex": "/new", "foreign": true }"#,
        r#"{"codex":"/codex","claude":"/claude"}"#,
        r#"{"codex":"relative","claude":7}"#,
        r#"{"claude":"/\ud800","codex":"/\udfff"}"#,
        r#"{"claude":"/😀","codex":"/�"}"#,
        r#"{"claude":"/first","\u0063laude":"/last","codex":"/codex"}"#,
        r#"{"claude":"/first","claude":null,"codex":"/codex"}"#,
        r#"{"claude":"/first","claude":"relative","codex":"/codex"}"#,
        r#"{"claude":"/keep","\ud800":"\udfff","foreign":1e99999}"#,
        r#"{"claude":"/keep"}garbage"#,
        r#"{"claude":"/keep","foreign":[}"#,
    ]
    .into_iter()
    .map(|s| Some(s.as_bytes().to_vec()))
    .collect();
    sources.extend([
        None,
        Some(format!("{{\"claude\":\"/keep\",\"foreign\":{deep}}}").into_bytes()),
        Some(b"{\"claude\":\"/\xff\xe0\x80\x80\"}".to_vec()),
    ]);
    let mut cases = Vec::new();
    for before in sources {
        for agent in ["claude-code", "codex", "unsupported"] {
            for mode in 0..6 {
                let variable = if agent == "claude-code" {
                    "CLAUDE_CONFIG_DIR"
                } else {
                    "CODEX_HOME"
                };
                let mut account = json!({});
                if mode == 3 {
                    account[variable] = json!("");
                }
                if mode == 4 {
                    account[variable] = json!("/named");
                }
                cases.push(json!({"before":before,"agent":agent,"account":account,"login":{"env":{variable:if mode==1 {"relative"} else {"/new"}},"profile_keys":if mode==2 {json!([])} else {json!([variable])},"login_shell":mode!=5}}));
            }
        }
    }
    for (before, next) in [
        (r#"{"codex":"/\ud800"}"#, "/�"),
        (r#"{ "codex": "/\ud83d\ude00", "ignored": 1 }"#, "/😀"),
        (r#"{"codex":"/keep"}"#, "/new"),
    ] {
        cases.push(json!({"before":before.as_bytes(),"agent":"codex","account":{},"login":{"env":{"CODEX_HOME":next},"profile_keys":["CODEX_HOME"],"login_shell":true}}));
    }
    // Omitted before means absent to the oracle, not a JSON-null byte buffer.
    for case in &mut cases {
        if case["before"].is_null() {
            case.as_object_mut().unwrap().remove("before");
        }
    }
    let mut child = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .arg("test/fixtures/orca-text-parity.ts")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"mode":"folders","cases":cases})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for (index, (case, want)) in cases.iter().zip(expected).enumerate() {
        let home =
            std::env::temp_dir().join(format!("pacer-folder-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(home.join("state")).unwrap();
        fs::set_permissions(home.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
        let file = home.join("state/default-account-folders.json");
        if let Some(before) = case.get("before") {
            let bytes: Vec<u8> = serde_json::from_value(before.clone()).unwrap();
            fs::write(&file, bytes).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let before = fs::metadata(&file).ok();
        let login = &case["login"];
        let login = LoginEnvironment {
            env: serde_json::from_value(login["env"].clone()).unwrap(),
            profile_keys: serde_json::from_value(login["profile_keys"].clone()).unwrap(),
            login_shell: login["login_shell"].as_bool().unwrap(),
        };
        let agent = case["agent"].as_str().unwrap();
        record(
            &home,
            if agent == "claude-code" {
                "claude"
            } else {
                agent
            },
            &serde_json::from_value(case["account"].clone()).unwrap(),
            &login,
        )
        .unwrap();
        let after = fs::metadata(&file).ok();
        let unchanged = match (&before, &after) {
            (Some(a), Some(b)) => {
                (a.ino(), a.mtime(), a.mtime_nsec()) == (b.ino(), b.mtime(), b.mtime_nsec())
            }
            (None, None) => true,
            _ => false,
        };
        let actual = json!({"bytes":fs::read(&file).ok(),"unchanged":unchanged});
        assert_eq!(actual, want, "case {index}: {case}");
        if let Some(after) = after {
            assert_eq!(after.permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn protected_existing_records_cannot_redirect_atomic_publication() {
    use std::{fs, os::unix::fs::symlink};
    for hard in [false, true] {
        let home =
            std::env::temp_dir().join(format!("pacer-folder-protected-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&home).unwrap();
        fs::create_dir(home.join("state")).unwrap();
        let target = home.join("other");
        fs::write(&target, br#"{"codex":"/old"}"#).unwrap();
        let path = home.join("state/default-account-folders.json");
        if hard {
            fs::hard_link(&target, &path).unwrap();
        } else {
            symlink(&target, &path).unwrap();
        }
        let base = LoginEnvironment {
            env: HashMap::from([("CODEX_HOME".into(), "/new".into())]),
            profile_keys: vec!["CODEX_HOME".into()],
            login_shell: true,
        };
        assert!(record(&home, "codex", &HashMap::new(), &base).is_err());
        assert_eq!(fs::read(&target).unwrap(), br#"{"codex":"/old"}"#);
        assert_eq!(fs::read_dir(home.join("state")).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }
}
