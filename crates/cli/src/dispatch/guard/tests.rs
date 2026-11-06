use super::write_marker;
use std::os::unix::fs::PermissionsExt;

#[test]
fn json_accepts_serde_reserved_key() {
    for input in [
        r#"{"tool_name":"Bash","other":{"$serde_json::private::Number":0}}"#,
        r#"{"$serde_json::private::Number":0}"#,
    ] {
        assert!(super::parse_js_json(input).is_ok(), "{input}");
    }
    let deep = format!(
        "{{\"tool_name\":\"Bash\",\"other\":{}0{}}}",
        "[".repeat(300),
        "]".repeat(300)
    );
    assert!(super::parse_js_json(&deep).is_ok());
}

#[test]
fn marker_write_is_exclusive_and_private() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("pacer-guard-mode-{}", std::process::id()));
    std::fs::create_dir(&root)?;
    let path = root.join("marker");
    write_marker(&path.to_string_lossy(), "first");
    assert_eq!(std::fs::read_to_string(&path)?, "first");
    assert_eq!(
        std::fs::metadata(&path)?.permissions().mode() & 0o777,
        0o600
    );
    write_marker(&path.to_string_lossy(), "second");
    assert_eq!(std::fs::read_to_string(&path)?, "first");
    std::fs::remove_file(path)?;
    std::fs::remove_dir(root)?;
    Ok(())
}
