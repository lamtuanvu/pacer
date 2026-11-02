#![allow(clippy::unwrap_used)]

//! These vectors are captured by test/session-ops-parity.test.ts from TypeScript.
use pacer_sessions::operations::{clean_summary, file_reference, report_summary};
use serde_json::{Value, json};

fn summary_view(units: &[u16]) -> Value {
    if units.len() <= 256 {
        json!({"codeUnits": units})
    } else {
        json!({"units": units.len(), "first": String::from_utf16(&units[..8]).unwrap(), "last": String::from_utf16(&units[units.len()-8..]).unwrap()})
    }
}

#[test]
fn typescript_reference_and_summary_goldens() {
    let golden: Value =
        serde_json::from_str(include_str!("../../../test/fixtures/session-ops/pure.json")).unwrap();
    for row in golden["references"].as_array().unwrap() {
        let text: Vec<u16> = row["reference"].as_str().unwrap().encode_utf16().collect();
        let actual = match file_reference(&text) {
            Ok(reference) => {
                let mut result = json!({"name": String::from_utf16(reference.name).unwrap()});
                if let Some(line) = reference.line {
                    result["line"] = json!(line);
                }
                if let Some(column) = reference.column {
                    result["column"] = json!(column);
                }
                json!({"result": result})
            }
            Err(error) => json!({"error": {"code": "invalid_input", "message": error.to_string()}}),
        };
        assert_eq!(actual, row["expected"], "reference: {}", row["reference"]);
    }
    for row in golden["summaries"].as_array().unwrap() {
        let input = &row["input"];
        let units: Vec<u16> = if let Some(units) = input["units"].as_array() {
            units.iter().map(|u| u.as_u64().unwrap() as u16).collect()
        } else {
            input["text"].as_str().unwrap().encode_utf16().collect()
        };
        let text = units.repeat(input["repeat"].as_u64().unwrap_or(1) as usize);
        assert_eq!(summary_view(&clean_summary(&text)), row["clean"]);
        assert_eq!(
            report_summary(&text, false).map(|s| summary_view(&s)),
            (!row["read"].is_null()).then(|| row["read"].clone())
        );
        let written = match report_summary(&text, true) {
            Some(summary) => json!({"result": summary_view(&summary)}),
            None => json!({"error": {"message": "report summary must contain 1–16000 characters"}}),
        };
        assert_eq!(written, row["written"], "summary input: {input}");
    }
}
