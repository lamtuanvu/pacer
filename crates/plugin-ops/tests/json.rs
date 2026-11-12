#![allow(clippy::unwrap_used)]
use pacer_plugin_ops::{json, settings};
#[test]
fn overflow_numbers_decode_like_javascript_and_stores_survive() {
    use pacer_foundation::Ctx;
    for wire in ["1e309", "-1e309", "1e400", "-1e400"] {
        let n = json::parse(wire.as_bytes()).unwrap();
        assert_eq!(settings::js_json(&n), "null");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap();
        let ctx = Ctx::with(path.clone(), path.clone(), Default::default(), 0.0);
        let store = format!(
            r#"{{"fx-ui":{{"rev":{wire},"values":{{"text":"kept"}},"hidden":[{wire},"activity:checklist"]}},"other":{{"rev":3,"values":{{"x":true}}}}}}"#
        );
        std::fs::write(path.join("plugin-settings.json"), &store).unwrap();
        assert_eq!(
            settings::read(&ctx, "fx-ui").unwrap()["values"]["text"],
            "kept"
        );
        assert_eq!(settings::read(&ctx, "other").unwrap()["rev"], 3);
        assert_eq!(
            settings::read(&ctx, "fx-ui").unwrap()["hidden"],
            serde_json::json!(["activity:checklist"])
        );
        assert_eq!(
            std::fs::read_to_string(path.join("plugin-settings.json")).unwrap(),
            store
        );
    }
}

#[test]
fn invalid_utf8_store_is_replaced_without_quarantine_and_bom_is_rejected() {
    use pacer_foundation::Ctx;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(root.clone(), root.clone(), Default::default(), 0.0);
    let file = root.join("plugin-settings.json");
    std::fs::write(
        &file,
        b"{\"fx-ui\":{\"rev\":3,\"values\":{\"a\":\"\xff\"}}}",
    )
    .unwrap();
    let r = settings::read(&ctx, "fx-ui").unwrap();
    assert_eq!(r["rev"], 3);
    assert_eq!(r["values"]["a"], "�");
    assert!(file.exists());
    std::fs::write(&file, b"\xef\xbb\xbf{\"fx-ui\":{\"rev\":3,\"values\":{}}}").unwrap();
    assert_eq!(settings::read(&ctx, "fx-ui").unwrap()["rev"], 0);
    assert!(!file.exists());
}

#[test]
fn deep_settings_require_typescript_without_quarantine() {
    use pacer_foundation::Ctx;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(root.clone(), root.clone(), Default::default(), 0.0);
    let nested = format!("{}0{}", "[".repeat(10000), "]".repeat(10000));
    let store = format!(r#"{{"fx-ui":{{"rev":7,"values":{{"deep":{nested}}}}}}}"#);
    let file = root.join("plugin-settings.json");
    std::fs::write(&file, &store).unwrap();
    let error = settings::read(&ctx, "fx-ui").unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::Code::Unavailable);
    assert_eq!(error.message, "JSON nesting requires TypeScript fallback");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), store);
    assert_eq!(std::fs::read_dir(root).unwrap().count(), 1);
}
