#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-jsonc.test.ts.
use pacer_plugin::install::{
    apply_undo, backup_path, get_member, is_empty_object, parse_jsonc, remove_member, set_member,
    strip_jsonc,
};
use serde_json::json;

const OPENCODE: &str = "{\n  // user comment\n  \"mcp\": {\n    \"other\": {\"type\": \"local\", \"command\": [\"other\",],},\n  },\n  \"theme\": \"dark\", /* trailing */\n}\n";

fn path(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

// test/plugin-sdk-install-jsonc.test.ts:14 comments and trailing commas with comment-like strings
#[test]
fn comments_and_trailing_commas_with_comment_like_strings() {
    assert_eq!(
        parse_jsonc(OPENCODE).unwrap(),
        json!({"mcp": {"other": {"type": "local", "command": ["other"]}}, "theme": "dark"})
    );
    let literal = r#"{"a": "// not a comment, ]"}"#;
    assert_eq!(strip_jsonc(literal), literal);
    assert_eq!(
        parse_jsonc(r#"{"a": "escaped \" /* string */", "b": [true, false, null, -1.25e+2,],}"#)
            .unwrap(),
        json!({"a": "escaped \" /* string */", "b": [true, false, null, -125]})
    );
}

// test/plugin-sdk-install-jsonc.test.ts:21 rejects invalid syntax and non-object roots
#[test]
fn rejects_invalid_syntax_and_non_object_roots() {
    for text in [
        "{ nope }",
        "[1]",
        r#"{"a": 01}"#,
        r#"{"a": 1} false"#,
        r#"{"a": "unterminated}"#,
        "{/* unterminated",
        r#"{"a": [1,,]}"#,
    ] {
        let error = parse_jsonc(text).unwrap_err().0;
        if text == "[1]" {
            assert!(error.contains("top level must be an object"));
        }
        assert!(error.contains("offset"), "{text}: {error}");
    }
}

// test/plugin-sdk-install-jsonc.test.ts:29 nbsp rejected by every entry point
#[test]
fn nbsp_rejected_by_every_entry_point() {
    let invalid = "{\u{a0}\"a\": 1}";
    assert!(get_member(invalid, &path(&["a"])).is_err());
    assert!(is_empty_object(invalid, &[]).is_err());
    assert!(set_member(invalid, &path(&["b"]), json!(2)).is_err());
    assert!(remove_member(invalid, &path(&["a"])).is_err());
}

// test/plugin-sdk-install-jsonc.test.ts:37 insert mcp.pacer preserving comments and exact removal
#[test]
fn insert_mcp_pacer_preserving_comments_and_exact_removal() {
    let pacer = json!({"type": "local", "command": ["pacer", "mcp"], "enabled": true});
    let installed = set_member(OPENCODE, &path(&["mcp", "pacer"]), pacer.clone()).unwrap();
    assert!(installed.contains("// user comment"));
    assert!(installed.contains("/* trailing */"));
    assert!(installed.contains("    \"pacer\": {\n      \"type\": \"local\","));
    assert_eq!(
        get_member(&installed, &path(&["mcp", "pacer"])).unwrap(),
        Some(pacer)
    );
    assert_eq!(
        remove_member(&installed, &path(&["mcp", "pacer"])).unwrap(),
        OPENCODE
    );
}

// test/plugin-sdk-install-jsonc.test.ts:46 replace changes only the value span
#[test]
fn replace_changes_only_the_value_span() {
    let original = "{\n  \"a\": 1 /* keep */,\n  \"b\": 2\n}\n";
    assert_eq!(
        set_member(original, &path(&["a"]), json!({"nested": true})).unwrap(),
        "{\n  \"a\": {\n    \"nested\": true\n  } /* keep */,\n  \"b\": 2\n}\n"
    );
}

// test/plugin-sdk-install-jsonc.test.ts:51 missing parents created and removed
#[test]
fn missing_parents_created_and_removed() {
    let bare = "{\n  \"theme\": \"dark\"\n}\n";
    let pacer = json!({"type": "local", "command": ["pacer", "mcp"], "enabled": true});
    let installed = set_member(bare, &path(&["mcp", "pacer"]), pacer.clone()).unwrap();
    assert_eq!(
        get_member(&installed, &path(&["mcp", "pacer"])).unwrap(),
        Some(pacer)
    );
    let removed = remove_member(&installed, &path(&["mcp", "pacer"])).unwrap();
    assert!(is_empty_object(&removed, &path(&["mcp"])).unwrap());
    assert_eq!(remove_member(&removed, &path(&["mcp"])).unwrap(), bare);
}

// test/plugin-sdk-install-jsonc.test.ts:60 empty object insertion
#[test]
fn empty_object_insertion() {
    let installed = set_member("{}", &path(&["a"]), json!(1)).unwrap();
    assert_eq!(installed, "{\n  \"a\": 1\n}");
    assert_eq!(remove_member(&installed, &path(&["a"])).unwrap(), "{}");
}

// test/plugin-sdk-install-jsonc.test.ts:65 inline cursor formatting
#[test]
fn inline_cursor_formatting() {
    let cursor = "{ \"mcpServers\": { \"GitKraken\": {\n\t\"command\": \"gk\"\n} } }\n";
    let installed = set_member(
        cursor,
        &path(&["mcpServers", "pacer"]),
        json!({"command": "pacer", "args": ["mcp"]}),
    )
    .unwrap();
    assert_eq!(
        get_member(&installed, &path(&["mcpServers", "GitKraken", "command"])).unwrap(),
        Some(json!("gk"))
    );
    assert_eq!(
        remove_member(&installed, &path(&["mcpServers", "pacer"])).unwrap(),
        cursor
    );
}

// test/plugin-sdk-install-jsonc.test.ts:72 lookup and missing removal preserve document
#[test]
fn lookup_and_missing_removal_preserve_document() {
    assert_eq!(
        get_member(OPENCODE, &[]).unwrap(),
        Some(parse_jsonc(OPENCODE).unwrap())
    );
    assert!(
        get_member(OPENCODE, &path(&["missing", "child"]))
            .unwrap()
            .is_none()
    );
    assert!(
        get_member(OPENCODE, &path(&["theme", "child"]))
            .unwrap()
            .is_none()
    );
    assert!(!is_empty_object(OPENCODE, &path(&["missing"])).unwrap());
    assert!(!is_empty_object(OPENCODE, &path(&["theme"])).unwrap());
    assert_eq!(
        remove_member(OPENCODE, &path(&["missing"])).unwrap(),
        OPENCODE
    );
}

// test/plugin-sdk-install-jsonc.test.ts:81 non-object parents reject insertion
#[test]
fn non_object_parents_reject_insertion() {
    for parent in [json!(null), json!([]), json!("value"), json!(1)] {
        let text = format!("{{\"mcp\": {parent}}}");
        assert!(set_member(&text, &path(&["mcp", "pacer"]), json!({})).is_err());
    }
}

// test/plugin-sdk-install-jsonc.test.ts:87 last member and trailing comma removal
#[test]
fn last_member_and_trailing_comma_removal() {
    assert_eq!(
        remove_member(r#"{"a": 1, "b": 2}"#, &path(&["b"])).unwrap(),
        r#"{"a": 1}"#
    );
    assert_eq!(
        remove_member(r#"{"a": 1, "b": 2,}"#, &path(&["b"])).unwrap(),
        r#"{"a": 1, }"#
    );
    assert_eq!(
        remove_member(r#"{ /* comment */ "a": 1, }"#, &path(&["a"])).unwrap(),
        "{}"
    );
}

// test/plugin-sdk-install-jsonc.test.ts:93 escaped keys and tabs
#[test]
fn escaped_keys_and_tabs() {
    let text = "{\n\t\"a\\\"b\": {},\n\t\"other\": true\n}";
    let nested = path(&["a\"b", "__proto__", "x"]);
    let installed = set_member(text, &nested, json!(2)).unwrap();
    assert_eq!(get_member(&installed, &nested).unwrap(), Some(json!(2)));
    let installed = set_member(text, &path(&["pacer"]), json!({"enabled": true})).unwrap();
    assert!(installed.contains("\n\t\"pacer\": {\n\t  \"enabled\": true"));
    assert_eq!(remove_member(&installed, &path(&["pacer"])).unwrap(), text);
}

// test/plugin-sdk-install-jsonc.test.ts:101 trailing line comment removed
#[test]
fn trailing_line_comment_removed() {
    for newline in ["\n", "\r\n"] {
        let text = [
            "{",
            "  \"keep\": 1, // keep comment",
            "  \"pacer\": 2, // pacer comment",
            "  \"other\": 3",
            "}",
            "",
        ]
        .join(newline);
        let expected = [
            "{",
            "  \"keep\": 1, // keep comment",
            "  \"other\": 3",
            "}",
            "",
        ]
        .join(newline);
        assert_eq!(remove_member(&text, &path(&["pacer"])).unwrap(), expected);
        assert_eq!(
            parse_jsonc(&remove_member(&text, &path(&["pacer"])).unwrap()).unwrap(),
            json!({"keep": 1, "other": 3})
        );
    }
}

// test/plugin-sdk-install-jsonc.test.ts:110 bom survives
#[test]
fn bom_survives() {
    let text = "\u{feff}{\n  \"a\": {},\n  \"keep\": 2, // user comment\n}\n";
    assert_eq!(parse_jsonc(text).unwrap(), json!({"a": {}, "keep": 2}));
    assert_eq!(
        parse_jsonc(&strip_jsonc(text)).unwrap(),
        json!({"a": {}, "keep": 2})
    );
    assert_eq!(get_member(text, &path(&["keep"])).unwrap(), Some(json!(2)));
    assert!(is_empty_object(text, &path(&["a"])).unwrap());
    assert_eq!(
        set_member(text, &path(&["keep"]), json!(3)).unwrap(),
        text.replace("\"keep\": 2", "\"keep\": 3")
    );
    let installed = set_member(text, &path(&["pacer"]), json!({"enabled": true})).unwrap();
    assert!(installed.starts_with('\u{feff}'));
    assert_eq!(remove_member(&installed, &path(&["pacer"])).unwrap(), text);
    assert_eq!(
        remove_member("\u{feff}{\"a\": 1}", &path(&["a"])).unwrap(),
        "\u{feff}{}"
    );
}

// test/plugin-sdk-install-entry.test.ts:3 public API needs no host
#[test]
fn public_api_needs_no_host() {
    let original = "\u{feff}{\n  // retained comment\n  \"owned\": true\n}\n";
    assert_eq!(parse_jsonc(original).unwrap(), json!({"owned": true}));
    let installed = pacer_plugin::install::upsert_block(
        "existing\n",
        "managed",
        pacer_plugin::install::BlockStyle::Md,
    )
    .unwrap();
    assert_eq!(
        apply_undo(
            &installed,
            &[pacer_plugin::install::UndoOp::Block {
                style: pacer_plugin::install::BlockStyle::Md,
                restore: None
            }],
            &mut Vec::new()
        )
        .unwrap(),
        "existing\n"
    );
    let tz = pacer_plugin::install::zone("UTC").unwrap();
    let first = backup_path("/fixture/config", 1700000000, &tz, |_| false);
    assert_ne!(
        backup_path("/fixture/config", 1700000000, &tz, |c| c == first),
        first
    );
}
