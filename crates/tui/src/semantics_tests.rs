#![allow(clippy::unwrap_used)]
use super::{layout, model, updates};
use serde_json::Value;

#[test]
fn javascript_coercions_and_text_match_reference() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/dashboard-frame/semantics.json"
    ))
    .unwrap();
    for case in fixtures["titles"].as_array().unwrap() {
        assert_eq!(model::title(&case["input"]), model::text(&case["output"]));
    }
    for case in fixtures["rounds"].as_array().unwrap() {
        assert_eq!(
            model::round(model::num(&case["input"])),
            model::text(&case["output"])
        );
    }
    for case in fixtures["numbers"].as_array().unwrap() {
        assert_eq!(
            model::number(model::js_number(&case["input"])),
            model::text(&case["output"]),
            "Number({})",
            case["input"]
        );
    }
    for case in fixtures["strings"].as_array().unwrap() {
        assert_eq!(
            model::js_string(&case["input"]),
            model::text(&case["output"]),
            "String({})",
            case["input"]
        );
    }
    for case in fixtures["times"].as_array().unwrap() {
        let input = model::num(&case["input"]);
        assert_eq!(model::ago(0., input), model::text(&case["ago"]));
        assert_eq!(model::elapsed(input), model::text(&case["elapsed"]));
    }
    for case in fixtures["clocks"].as_array().unwrap() {
        assert_eq!(
            model::clock(model::num(&case["at"]), model::num(&case["now"])),
            model::text(&case["output"])
        );
    }
    for case in fixtures["text"].as_array().unwrap() {
        let s = model::text(&case["input"]);
        let w = model::num(&case["width"]) as usize;
        assert_eq!(super::safe_text(s), model::text(&case["safe"]));
        assert_eq!(super::cell_width(s), model::num(&case["cells"]) as usize);
        assert_eq!(super::clip(s, w, "…"), model::text(&case["clipped"]));
        assert_eq!(serde_json::json!(layout::wrap(s, w, 3)), case["wrapped"]);
    }
    for case in fixtures["paths"].as_array().unwrap() {
        assert_eq!(
            serde_json::json!(updates::wrap_path_units(
                model::text(&case["input"]),
                model::num(&case["width"]) as usize
            )),
            case["units"]
        );
    }
}
