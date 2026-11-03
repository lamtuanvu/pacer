//! Q1/Q2 pins of the existing queue no-op comparator. `admission_json_eq`
//! (`admission_json_eq.rs`) must reproduce these results.
#![allow(clippy::unwrap_used)]
#[path = "support/queue_pairs.rs"]
mod pairs;
use pairs::*;

#[test]
fn q1_numeric_canonicalization_of_the_existing_comparator() {
    for (a, b, equal) in NUMBER_PAIRS {
        assert_eq!(old_equal(a, b), *equal, "{a} vs {b}");
    }
}

#[test]
fn q2_object_order_and_exact_units_of_the_existing_comparator() {
    for (a, b, equal) in STRUCTURE_PAIRS {
        assert_eq!(old_equal(a, b), *equal, "{a} vs {b}");
    }
    for (a, b, equal) in KEY_PAIRS {
        assert_eq!(admission_equal(a, b), *equal, "{a} vs {b}");
    }
}
