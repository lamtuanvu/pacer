#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugins-planner-read.test.ts.
use pacer_plugin::install::{PriorReference, create_planner_io, host_call, read_planner_prior};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn b64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

// test/plugins-planner-read.test.ts:6 inline image without mode refused
#[tokio::test]
async fn inline_image_without_mode_refused() {
    let host = host_call(|method, _| {
        Box::pin(async move {
            assert_eq!(method, "capability.fs.read");
            Ok(json!({"text": "config", "mtime": 1}))
        })
    }) as pacer_plugin::install::HostCall;
    let io = create_planner_io(host, None);
    assert!(
        io.base
            .read("/synthetic/config")
            .await
            .unwrap_err()
            .contains("mode")
    );
}

// test/plugins-planner-read.test.ts:12 missing and host errors kept
#[tokio::test]
async fn missing_and_host_errors_kept() {
    let missing = host_call(|_, _| Box::pin(async { Ok(json!({"missing": true})) }));
    assert!(
        create_planner_io(missing, None)
            .base
            .read("/synthetic/config")
            .await
            .unwrap()
            .is_none()
    );
    let denied = host_call(|_, _| Box::pin(async { Err("denied".into()) }));
    assert_eq!(
        create_planner_io(denied, None)
            .base
            .read("/synthetic/config")
            .await
            .unwrap_err(),
        "denied"
    );
}

// test/plugins-planner-read.test.ts:26 every range checks mode and length
#[tokio::test]
async fn every_range_checks_mode_and_length() {
    let info = json!({
        "path": "/synthetic/config",
        "size": 262145,
        "mtimeMs": 1,
        "inode": 1,
        "device": 2,
        "mode": 0o100700,
    });
    let offset = Arc::new(Mutex::new(0usize));
    let expected_info = info.clone();
    let host = host_call(move |method, params| {
        let info = info.clone();
        let offset = Arc::clone(&offset);
        let expected_info = expected_info.clone();
        Box::pin(async move {
            if method == "capability.fs.read" {
                return Ok(json!({"ranged": info}));
            }
            assert_eq!(params["expected"]["mode"], expected_info["mode"]);
            let length =
                262144.min(info["size"].as_u64().unwrap() as usize - *offset.lock().unwrap());
            *offset.lock().unwrap() += length;
            let mode = if *offset.lock().unwrap() > 262144 {
                0o100600
            } else {
                0o100700
            };
            Ok(json!({"base64": b64(&vec![b'a'; length]), "info": {
                "path": info["path"], "size": info["size"], "mtimeMs": info["mtimeMs"],
                "inode": info["inode"], "device": info["device"], "mode": mode,
            }}))
        })
    });
    let io = create_planner_io(host, None);
    assert!(
        io.base
            .read("/synthetic/config")
            .await
            .unwrap_err()
            .contains("changed")
    );
}

// test/plugins-planner-read.test.ts:51 prior projection exact bytes strict utf8
#[tokio::test]
async fn prior_projection_exact_bytes_strict_utf8() {
    let invalid = host_call(|_, _| Box::pin(async { Ok(json!({"base64": b64(&[255])})) }));
    let reference = PriorReference {
        handle: "bound".into(),
        bytes: 1,
    };
    assert!(
        read_planner_prior(invalid, reference.clone())
            .await
            .is_err()
    );
    let empty = host_call(|_, _| Box::pin(async { Ok(json!({"base64": ""})) }));
    assert!(read_planner_prior(empty, reference).await.is_err());
    let valid = host_call(|_, _| Box::pin(async { Ok(json!({"base64": b64(br#"{"a":1}"#)})) }));
    let value: Value = read_planner_prior(
        valid,
        PriorReference {
            handle: "bound".into(),
            bytes: 7,
        },
    )
    .await
    .unwrap();
    assert_eq!(value, json!({"a": 1}));
}
