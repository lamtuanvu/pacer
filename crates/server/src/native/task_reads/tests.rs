#![allow(clippy::unwrap_used)]
use super::*;
use std::{collections::HashMap, fs};

#[test]
fn exit_receipt_number_matches_js_number_and_trim() {
    for whitespace in [
        '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', '\u{0020}', '\u{00A0}',
        '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
        '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}',
        '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
    ] {
        assert_eq!(js_trim(&format!("{whitespace}2{whitespace}")), "2");
    }
    for non_js_whitespace in ['\u{0085}', '\u{180E}'] {
        assert!(!finite_js_number(&format!("{non_js_whitespace}2")));
    }
    for (text, expected) in [
        ("0", true),
        ("0x10", true),
        ("0b101", true),
        ("0o77", true),
        ("0x", false),
        ("0xg", false),
        ("Infinity", false),
        ("\u{feff}0x10\u{feff}", true),
        ("\u{2028}0b101\u{2029}", true),
        ("\u{00a0}2\u{3000}", true),
        ("\u{0085}2", false),
    ] {
        assert_eq!(finite_js_number(text), expected, "{text:?}");
    }
    assert!(!finite_js_number(&format!("0x{}", "f".repeat(400))));
    assert!(finite_js_number(&format!("0x1{}", "0".repeat(255))));
}

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(dir.path().into(), dir.path().into(), HashMap::new(), 1000.0)
}

#[tokio::test]
async fn activity_pages_by_file_order_and_filters_malformed_rows() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("state")).unwrap();
    fs::write(dir.path().join("state/activity.jsonl"),
            "{\"id\":\"a\",\"at\":1,\"kind\":\"config\",\"level\":\"info\",\"text\":\"first\",\"repo\":\"r\"}\ninvalid\n{\"id\":\"b\",\"at\":1,\"kind\":\"mode\",\"level\":\"warn\",\"text\":\"second\"}\n{\"id\":\"c\",\"at\":1,\"kind\":\"config\",\"level\":\"info\",\"text\":\"third\",\"repo\":\"r\",\"taskId\":\"t\"}\n").unwrap();
    let c = ctx(&dir);
    let first = activity_list(&c, json!({"limit":2})).await.unwrap();
    assert_eq!(first["entries"][0]["id"], "c");
    assert_eq!(first["entries"][1]["id"], "b");
    assert_eq!(first["next"], "b");
    assert_eq!(
        activity_list(&c, json!({"before":"b"})).await.unwrap()["entries"][0]["id"],
        "a"
    );
    assert_eq!(
        activity_list(&c, json!({"repo":"r","kinds":["config"],"taskId":"t"}))
            .await
            .unwrap()["entries"][0]["id"],
        "c"
    );
    assert!(
        activity_list(&c, json!({"before":"missing"}))
            .await
            .unwrap()["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        activity_list(&c, json!({"limit":501}))
            .await
            .unwrap_err()
            .message,
        "limit: Too big: expected number to be <=500"
    );
    assert_eq!(
        activity_list(&c, json!({"before":"","limit":0}))
            .await
            .unwrap_err()
            .message,
        "before: Too small: expected string to have >=1 characters; limit: Too small: expected number to be >=1"
    );
}

#[tokio::test]
async fn activity_limit_accepts_integral_json_forms() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("state")).unwrap();
    let rows = (0..101).map(|n| format!("{{\"id\":\"{n}\",\"at\":1,\"kind\":\"config\",\"level\":\"info\",\"text\":\"row\"}}\n")).collect::<String>();
    fs::write(dir.path().join("state/activity.jsonl"), rows).unwrap();
    let c = ctx(&dir);
    for (raw, expected) in [("2", 2), ("2.0", 2), ("1e2", 100)] {
        let params = serde_json::from_str(&format!("{{\"limit\":{raw}}}")).unwrap();
        let result = activity_list(&c, params).await.unwrap();
        assert_eq!(
            result["entries"].as_array().unwrap().len(),
            expected,
            "{raw}"
        );
        assert!(result["next"].is_string(), "{raw}");
    }
    for (raw, message) in [
        ("1.5", "limit: Invalid input: expected int, received number"),
        ("0", "limit: Too small: expected number to be >=1"),
        ("501", "limit: Too big: expected number to be <=500"),
        (
            "9007199254740992",
            "limit: Too big: expected int to be <=9007199254740991; limit: Too big: expected number to be <=500",
        ),
        (
            "-9007199254740992",
            "limit: Too small: expected int to be >=-9007199254740991; limit: Too small: expected number to be >=1",
        ),
    ] {
        let params = serde_json::from_str(&format!("{{\"limit\":{raw}}}")).unwrap();
        assert_eq!(
            activity_list(&c, params).await.unwrap_err().message,
            message,
            "{raw}"
        );
    }
    let emoji = "😀".repeat(128);
    assert!(activity_list(&c, json!({"taskId": emoji})).await.is_ok());
    assert_eq!(
        activity_list(&c, json!({"taskId": "😀".repeat(129)}))
            .await
            .unwrap_err()
            .code,
        Code::InvalidInput
    );
}

#[tokio::test]
async fn task_log_reads_byte_offsets_caps_and_reports_source() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let id = "t-20261101-184223-ea3b";
    let run = dir.path().join("runs/test");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("stdout"), vec![b'x'; 256 * 1024 + 3]).unwrap();
    fs::write(run.join("stderr"), "error").unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    store.insert(&json!({"id":id,"rev":1,"state":"running","createdAt":1000,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
    let first = task_log(&c, json!({"id":id})).await.unwrap();
    assert_eq!(first["stdout"].as_str().unwrap().len(), 256 * 1024);
    assert_eq!(first["next"]["stdout"], 256 * 1024);
    assert_eq!(first["stderr"], "error");
    assert_eq!(first["done"], false);
    let second = task_log(&c, json!({"id":id,"stdout":256 * 1024,"stderr":5}))
        .await
        .unwrap();
    assert_eq!(second["stdout"], "xxx");
    assert_eq!(second["source"], first["source"]);
    fs::write(run.join("exit"), "0\n").unwrap();
    assert_eq!(task_log(&c, json!({"id":id})).await.unwrap()["done"], true);
    fs::write(run.join("exit"), "0x0\n").unwrap();
    assert_eq!(task_log(&c, json!({"id":id})).await.unwrap()["done"], true);
    assert_eq!(
        task_log(&c, json!({"id":"missing"}))
            .await
            .unwrap_err()
            .code,
        Code::UnknownTask
    );
    assert_eq!(
        task_log(&c, json!({"id":id,"stdout":-1}))
            .await
            .unwrap_err()
            .code,
        Code::InvalidInput
    );
    assert_eq!(
        task_log(&c, json!({"id":"","stdout":-1}))
            .await
            .unwrap_err()
            .message,
        "id: Too small: expected string to have >=1 characters; stdout: Too small: expected number to be >=0"
    );
}

#[tokio::test]
async fn task_log_accepts_integral_json_offsets() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let id = "t-20261101-184223-ea3b";
    let run = dir.path().join("runs/test");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("stdout"), "0123456789".repeat(11)).unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    store.insert(&json!({"id":id,"rev":1,"state":"running","createdAt":1000,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
    for field in ["stdout", "stderr"] {
        for (raw, expected) in [
            ("2", 2_u64),
            ("2.0", 2),
            ("1e2", 100),
            ("9007199254740991", 9_007_199_254_740_991),
        ] {
            let params =
                serde_json::from_str(&format!("{{\"id\":\"{id}\",\"{field}\":{raw}}}")).unwrap();
            let result = task_log(&c, params).await.unwrap();
            assert_eq!(
                result["next"][field],
                if field == "stdout" && expected < 110 {
                    expected.max(110)
                } else {
                    expected
                },
                "{field}={raw}"
            );
        }
        for (raw, message) in [
            ("-1", "Too small"),
            ("0.5", "expected int"),
            ("9007199254740992", "Too big"),
            ("-9007199254740992", "Too small: expected int"),
        ] {
            let params =
                serde_json::from_str(&format!("{{\"id\":\"{id}\",\"{field}\":{raw}}}")).unwrap();
            assert!(
                task_log(&c, params)
                    .await
                    .unwrap_err()
                    .message
                    .contains(message),
                "{field}={raw}"
            );
        }
    }
    assert!(
        task_log(&c, json!({"id": "😀".repeat(128)}))
            .await
            .unwrap_err()
            .code
            == Code::UnknownTask
    );
}
