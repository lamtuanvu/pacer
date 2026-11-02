#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_sessions::offset::parse_from;
use serde_json::{Value, json};
#[test]
fn websocket_query_numbers_match_ts_route() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/sessions/routes-parity.json"
    ))
    .unwrap();
    for row in corpus["rows"].as_array().unwrap() {
        let result = parse_from(row["raw"].as_str());
        if row["status"] == 400 {
            assert!(result.is_err(), "{}", row["raw"]);
        } else {
            assert_eq!(json!(result.unwrap()), row["from"], "{}", row["raw"]);
        }
    }
}
