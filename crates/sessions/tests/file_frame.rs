#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_sessions::{
    files,
    framing::{self, FrameError, LogHeader, WireDecoder},
    masking::SecretMasker,
    recording, version,
};
use serde_json::{Value, json};
use std::fs;

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/sessions/host-parity.json"
    ))
    .unwrap()
}

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/sessions/host-corpus.json"
    ))
    .unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn log_and_wire_match_typescript_capture() {
    let g = golden();
    let header: LogHeader = serde_json::from_value(g["header"].clone()).unwrap();
    let mut raw = framing::encode_header(&header).unwrap();
    let mut integer_header = header.clone();
    integer_header.started_at = 1.0;
    assert_eq!(
        hex(&framing::encode_header(&integer_header).unwrap()),
        g["integerHeaderHex"]
    );
    raw.extend(framing::encode_record(1, 12.9, b"hello"));
    raw.extend(framing::encode_record(2, 13.0, &[0, 80, 0, 24]));
    raw.extend([1, 0, 0]);
    assert_eq!(hex(&raw), g["logHex"]);
    let decoded = framing::decode_log(&raw).unwrap();
    assert_eq!(decoded.header, g["decoded"]["header"]);
    assert_eq!(decoded.valid_bytes, g["decoded"]["validBytes"]);
    for (frame, expected) in decoded
        .frames
        .iter()
        .zip(g["decoded"]["frames"].as_array().unwrap())
    {
        assert_eq!(frame.kind, expected["type"]);
        assert_eq!(frame.ms, expected["ms"].as_u64().map(|x| x as u32));
        assert_eq!(hex(&frame.data), expected["data"]);
    }
    let packet = framing::wire(3, b"hello").unwrap();
    assert_eq!(hex(&packet), g["wireHex"]);
    let mut decoder = WireDecoder::default();
    assert!(decoder.push(&packet[..2]).unwrap().is_empty());
    let frames = decoder.push(&packet[2..]).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].kind, 3);
    assert_eq!(hex(&frames[0].data), "68656c6c6f");
}

#[test]
fn malformed_and_incremental_frames_follow_typescript() {
    assert_eq!(
        framing::decode_log(b"bad").unwrap_err(),
        FrameError::InvalidHeader
    );
    let mut log =
        framing::encode_header(&serde_json::from_value(golden()["header"].clone()).unwrap())
            .unwrap();
    log[9..13].copy_from_slice(&((framing::MAX_FRAME + 1) as u32).to_be_bytes());
    assert_eq!(
        framing::decode_log(&log).unwrap_err(),
        FrameError::IncompleteHeader
    );
    let mut decoder = WireDecoder::default();
    assert_eq!(
        decoder.push(&[3, 1, 0, 0, 1]).unwrap_err(),
        FrameError::TooLarge
    );
    let packet = framing::wire(1, b"abc").unwrap();
    let mut decoder = WireDecoder::default();
    assert!(decoder.push(&packet[..7]).unwrap().is_empty());
    assert_eq!(decoder.push(&packet[7..]).unwrap()[0].data, b"abc");
}

#[test]
fn timestamp_clamp_wire_cap_and_consecutive_frames() {
    let g = golden();
    for row in g["recordMs"].as_array().unwrap() {
        let ms = match row["input"].as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            other => other.parse().unwrap(),
        };
        assert_eq!(hex(&framing::encode_record(1, ms, b"")), row["hex"]);
    }
    assert_eq!(
        framing::wire(1, &vec![0; framing::MAX_FRAME + 1]).unwrap_err(),
        FrameError::TooLarge
    );
    let mut joined = framing::wire(1, b"a").unwrap();
    joined.extend(framing::wire(2, b"b").unwrap());
    let mut decoder = WireDecoder::default();
    let frames = decoder.push(&joined).unwrap();
    assert_eq!(
        frames.iter().map(|f| f.kind).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        frames.iter().map(|f| f.data.clone()).collect::<Vec<_>>(),
        vec![b"a".to_vec(), b"b".to_vec()]
    );
}

#[test]
fn masker_and_recording_files_match_typescript() {
    let g = golden();
    let mut mask = SecretMasker::new(&[
        "sensitive-secret".into(),
        "short".into(),
        "sensitive-secret".into(),
    ]);
    let got = [
        mask.push(b"before sen"),
        mask.push(b"sitive-secret after"),
        mask.flush(),
    ];
    assert_eq!(
        got.map(|s| String::from_utf8(s).unwrap()),
        [
            g["masked"][0].as_str().unwrap(),
            g["masked"][1].as_str().unwrap(),
            g["masked"][2].as_str().unwrap()
        ]
    );
    let dir = tempfile::tempdir().unwrap();
    let h: LogHeader = serde_json::from_value(
        json!({"cols":120,"rows":40,"startedAt":1,"generation":0,"outputOffset":0}),
    )
    .unwrap();
    let mut log = framing::encode_header(&h).unwrap();
    log.extend(framing::encode_record(1, 0.0, b"one\r\ntwo\n"));
    log.extend(framing::encode_record(2, 0.0, &[0, 80, 0, 24]));
    log.extend(framing::encode_record(
        3,
        0.0,
        br#"{"event":"take","label":"owner"}"#,
    ));
    fs::write(dir.path().join("session.log"), log).unwrap();
    fs::write(
        dir.path().join("session.ckpt"),
        serde_json::to_vec(&g["live"]["checkpoint"]).unwrap(),
    )
    .unwrap();
    let read = recording::read_recording(dir.path(), None).unwrap();
    assert_eq!(read.checkpoint.unwrap(), g["live"]["checkpoint"]);
    assert_eq!(
        read.frames
            .iter()
            .map(|f| json!({"type":f.kind,"data":hex(&f.data)}))
            .collect::<Vec<_>>(),
        g["live"]["readFrames"].as_array().unwrap().clone()
    );
    assert_eq!(
        recording::since(dir.path(), 3, 9).unwrap().concat(),
        b"\r\ntwo\n"
    );
    assert!(recording::since(dir.path(), 10, 9).is_none());
}

#[test]
fn host_version_validation_and_negotiation() {
    let dir = tempfile::tempdir().unwrap();
    let g = golden();
    let mut version = g["version"].clone();
    version["pacer"] = json!("0.12.1");
    fs::write(
        dir.path().join("session.version"),
        serde_json::to_vec(&version).unwrap(),
    )
    .unwrap();
    let parsed = version::read_session_version(dir.path()).unwrap();
    assert_eq!(parsed.identity.unwrap().pid, 42);
    assert_eq!(version::negotiate(None, [1, 1]), Some(1));
    assert_eq!(version::negotiate(Some([2, 3]), [1, 1]), None);
    assert!(version::host_supported(
        version::read_session_version(dir.path()).as_ref(),
        "0.15.0",
        [1, 1]
    ));
    assert!(!version::host_supported(
        version::read_session_version(dir.path()).as_ref(),
        "0.16.0",
        [1, 1]
    ));
    assert!(version::host_supported(None, "0.12.0", [1, 1]));
    assert!(!version::host_supported(
        Some(&version::SessionVersion {
            pacer: "0.12.0".into(),
            versions: [2, 2],
            identity: None
        }),
        "0.12.0",
        [1, 1]
    ));
    assert!(version::host_supported(
        Some(&version::SessionVersion {
            pacer: "1.0.0".into(),
            versions: [1, 1],
            identity: None
        }),
        "0.12.0",
        [1, 1]
    ));
    assert!(version::host_older(None, "0.12.0"));
    assert!(version::host_older(
        Some(&version::SessionVersion {
            pacer: "0.11.3".into(),
            versions: [1, 1],
            identity: None
        }),
        "0.12.0"
    ));
    assert!(!version::host_older(
        Some(&version::SessionVersion {
            pacer: "0.12.0".into(),
            versions: [1, 1],
            identity: None
        }),
        "0.12.0"
    ));
    fs::write(dir.path().join("session.version"), br#"{"pacer":1}"#).unwrap();
    assert!(version::read_session_version(dir.path()).is_none());
    fs::write(dir.path().join("session.version"), br#"{"pacer":"0.12.1","versions":[1.0,1.0],"identity":{"pid":42.0,"bootId":"b","birth":"1"}}"#).unwrap();
    assert_eq!(
        version::read_session_version(dir.path()).unwrap().versions,
        [1, 1]
    );
    assert_eq!(version::parse_versions(&json!([1.0, 2.0])), Some([1, 2]));
    assert_eq!(version::parse_versions(&json!([0, 1])), None);
    assert_eq!(version::parse_versions(&json!([2, 1])), None);
    assert_eq!(
        version::parse_versions(&json!([1, 9_007_199_254_740_992_u64])),
        None
    );
}

#[test]
fn legacy_launch_state_checkpoint_and_retention_contract() {
    for release in ["0.10.0", "0.11.0", "0.12.0"] {
        let root = format!("../../test/fixtures/upgrade/{release}/run-interactive");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(root);
        let launch: files::SessionLaunch =
            serde_json::from_slice(&fs::read(root.join("session.json")).unwrap()).unwrap();
        assert_eq!(launch.cap_bytes, Some(8 * 1024 * 1024));
        assert!(!launch.argv.is_empty());
        let state: files::SessionState =
            serde_json::from_slice(&fs::read(root.join("session.state")).unwrap()).unwrap();
        assert_eq!(state.controller, None);
        let checkpoint: files::Checkpoint =
            serde_json::from_slice(&fs::read(root.join("session.ckpt")).unwrap()).unwrap();
        assert_eq!(checkpoint.output_offset, 0);
    }
    assert!(files::PRUNED_SESSION_ARTIFACTS.contains(&"session.version"));
    assert!(!files::PRUNED_SESSION_ARTIFACTS.contains(&"stdout"));
    assert!(!files::retention_due(true, 14.0 * 86_400.0, 0.0, 14.0));
    assert!(files::retention_due(true, 14.0 * 86_400.0 + 1.0, 0.0, 14.0));
    assert!(!files::retention_due(false, 100.0 * 86_400.0, 0.0, 14.0));
}

#[test]
fn seeded_typescript_file_and_masking_corpus() {
    let c = corpus();
    for row in c["logs"].as_array().unwrap() {
        let raw = row["hex"].as_str().unwrap();
        let bytes: Vec<u8> = raw
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        match framing::decode_log(&bytes) {
            Ok(log) => {
                assert!(row.get("error").is_none(), "{}", row["name"]);
                assert_eq!(log.valid_bytes, row["result"]["validBytes"]);
                assert_eq!(
                    log.frames.iter().map(|f| f.kind).collect::<Vec<_>>(),
                    row["result"]["types"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect::<Vec<_>>()
                );
            }
            Err(FrameError::InvalidJson(_)) if row["name"] == "bad-json" => {
                assert!(
                    row["error"]
                        .as_str()
                        .unwrap()
                        .starts_with("JSON Parse error:")
                );
            }
            Err(err) => assert_eq!(err.to_string(), row["error"], "{}", row["name"]),
        }
    }
    for row in c["masking"].as_array().unwrap() {
        let secrets: Vec<String> = row["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        let mut mask = SecretMasker::new(&secrets);
        let mut out: Vec<String> = row["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| hex(&mask.push(v.as_str().unwrap().as_bytes())))
            .collect();
        out.push(hex(&mask.flush()));
        assert_eq!(
            out,
            row["out"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn rotated_generation_reads_match_typescript_capture() {
    let g = golden();
    let dir = tempfile::tempdir().unwrap();
    for (name, field) in [("session.log.1", "old"), ("session.log", "current")] {
        let item = &g["rotation"][field];
        let header: LogHeader = serde_json::from_value(json!({
            "cols":120,"rows":40,"startedAt":1,"generation":item["generation"],"outputOffset":item["outputOffset"]
        })).unwrap();
        let mut bytes = framing::encode_header(&header).unwrap();
        for frame in item["frames"].as_array().unwrap() {
            let raw = frame["data"].as_str().unwrap();
            let payload: Vec<u8> = raw
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            bytes.extend(framing::encode_record(
                frame["type"].as_u64().unwrap() as u8,
                0.0,
                &payload,
            ));
        }
        fs::write(dir.path().join(name), bytes).unwrap();
    }
    fs::write(
        dir.path().join("session.ckpt"),
        serde_json::to_vec(&g["rotation"]["checkpoint"]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        recording::since(dir.path(), 2, 9)
            .unwrap()
            .iter()
            .map(|b| hex(b))
            .collect::<Vec<_>>(),
        g["rotation"]["since2"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>()
    );
    let read = recording::read_recording(dir.path(), None).unwrap();
    assert_eq!(read.checkpoint.unwrap(), g["rotation"]["checkpoint"]);
    assert_eq!(
        read.frames
            .iter()
            .map(|f| json!({"type":f.kind,"data":hex(&f.data)}))
            .collect::<Vec<_>>(),
        g["rotation"]["readFrames"].as_array().unwrap().clone()
    );
}

#[test]
fn masking_longest_overlap_at_every_byte_split() {
    let g = golden();
    let raw = g["overlap"]["inputHex"].as_str().unwrap();
    let input: Vec<u8> = raw
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    let secrets: Vec<String> = g["overlap"]["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    for split in 0..=input.len() {
        let mut mask = SecretMasker::new(&secrets);
        let mut out = mask.push(&input[..split]);
        out.extend(mask.push(&input[split..]));
        out.extend(mask.flush());
        assert_eq!(hex(&out), g["overlap"]["expectedHex"]);
    }
}

#[test]
fn crash_between_rename_and_new_header_uses_previous_generation() {
    let dir = tempfile::tempdir().unwrap();
    let header: LogHeader = serde_json::from_value(
        json!({"cols":120,"rows":40,"startedAt":1,"generation":0,"outputOffset":0}),
    )
    .unwrap();
    let mut bytes = framing::encode_header(&header).unwrap();
    bytes.extend(framing::encode_record(1, 0.0, b"abc"));
    fs::write(dir.path().join("session.log.1"), bytes).unwrap();
    let read = recording::read_recording(dir.path(), None).unwrap();
    assert_eq!(read.frames[0].data, b"abc");
    assert_eq!(
        recording::read_recording(dir.path(), Some(0))
            .unwrap()
            .frames[0]
            .data,
        b"abc"
    );
    assert!(recording::since(dir.path(), 9_007_199_254_740_992, 9_007_199_254_740_992).is_none());
}

#[test]
fn checkpoint_slicing_and_missing_log_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let checkpoint = json!({"generation":0,"outputOffset":2,"cols":120,"rows":40,"scrollbackAnsi":"ab","screenAnsi":"","modes":{}});
    fs::write(
        dir.path().join("session.ckpt"),
        serde_json::to_vec(&checkpoint).unwrap(),
    )
    .unwrap();
    let header: LogHeader = serde_json::from_value(
        json!({"cols":120,"rows":40,"startedAt":1,"generation":0,"outputOffset":0}),
    )
    .unwrap();
    let mut bytes = framing::encode_header(&header).unwrap();
    bytes.extend(framing::encode_record(1, 0.0, b"abcd"));
    bytes.extend(framing::encode_record(3, 0.0, b"marker"));
    fs::write(dir.path().join("session.log"), bytes).unwrap();
    let read = recording::read_recording(dir.path(), None).unwrap();
    assert_eq!(
        read.frames
            .iter()
            .map(|f| f.data.clone())
            .collect::<Vec<_>>(),
        vec![b"cd".to_vec(), b"marker".to_vec()]
    );
    assert_eq!(
        recording::read_recording(dir.path(), Some(1))
            .unwrap()
            .frames[0]
            .data,
        b"bcd"
    );
    fs::remove_file(dir.path().join("session.log")).unwrap();
    assert_eq!(
        recording::read_recording(dir.path(), Some(2))
            .unwrap()
            .checkpoint,
        None
    );
    assert_eq!(
        recording::read_recording(dir.path(), Some(0))
            .unwrap()
            .checkpoint,
        Some(checkpoint)
    );
}
