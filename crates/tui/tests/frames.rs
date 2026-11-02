#![allow(clippy::unwrap_used)]
use pacer_tui::render_frame;
use serde_json::Value;

#[test]
fn every_typescript_frame_matches_test_backend() {
    let inputs: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/dashboard-frame/inputs.json"
    ))
    .unwrap();
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/dashboard-frame/golden.json"
    ))
    .unwrap();
    let mut failures = vec![];
    let cases = inputs["cases"].as_array().unwrap();
    assert_eq!(cases.len(), goldens.as_object().unwrap().len());
    let mut names = std::collections::HashSet::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name), "duplicate frame: {name}");
        let actual = render_frame(&inputs, case).unwrap();
        let expected = goldens[name]
            .as_str()
            .unwrap_or_else(|| panic!("missing golden: {name}"));
        assert_eq!(
            actual.split('\n').count(),
            case["height"].as_u64().unwrap() as usize,
            "{name}: row count"
        );
        if actual != expected {
            let differences: Vec<_> = actual
                .split('\n')
                .zip(expected.split('\n'))
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .map(|(i, (a, b))| format!("row {i}:\nactual: {a:?}\nexpect: {b:?}"))
                .collect();
            failures.push(format!("{name}:\n{}", differences.join("\n")));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
