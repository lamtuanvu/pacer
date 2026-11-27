//! B12-5 helper coverage: `pick_limit` and `freshness_of` are `pub(crate)` and
//! re-exported under `compute::testing` for this integration test. The literal
//! inputs below are the ones the brief specifies.

use pacer_status::compute::testing::{freshness_of, pick_limit};
use serde_json::json;

#[test]
fn pick_limit_prefers_the_latest_end_and_marks_configuration_manual() {
    let facts = vec![
        json!({"source":"execution","observedAt":10.0,"validUntil":100.0,"value":{"resetsAt":100.0}}),
        json!({"source":"configuration","observedAt":20.0,"validUntil":null,"value":{"resetsAt":200.0}}),
    ];
    assert_eq!(
        pick_limit(&facts),
        json!({"until":200.0,"observedAt":20.0,"manual":true})
    );
}

#[test]
fn freshness_of_a_limited_record_is_fresh_even_when_the_reading_aged() {
    let reading = json!({"stale": true});
    assert_eq!(
        freshness_of(&reading, None, &[], Some(&json!({"until": 5.0}))),
        "fresh"
    );
    assert_eq!(freshness_of(&reading, None, &[], None), "historical");
    assert_eq!(
        freshness_of(&json!({"stale": false}), None, &[], None),
        "unknown"
    );
}
