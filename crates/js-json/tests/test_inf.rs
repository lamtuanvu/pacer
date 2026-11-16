use pacer_js_json::quoted;
use serde_json::json;

#[test]
fn test_infinity_stringify() {
    let value = json!({"lastUsed": f64::INFINITY});
    let result = quoted::stringify(&value);
    println!("Result: {}", result);
    assert_eq!(result, r#"{"lastUsed":null}"#);
}
