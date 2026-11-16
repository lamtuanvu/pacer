use pacer_js_json::quoted;

#[test]
fn test_parse_infinity() {
    let json = r#"{"lastUsed": 1e400}"#;
    let value = quoted::parse(json.as_bytes()).unwrap();
    println!("Parsed value: {:?}", value);
    println!("lastUsed: {:?}", value["lastUsed"]);
    if let Some(s) = value["lastUsed"].as_str() {
        println!("lastUsed as string: {:?}", s);
        println!("Bytes: {:?}", s.as_bytes());
        println!("Contains fdd0: {}", s.contains('\u{fdd0}'));
    }
}
