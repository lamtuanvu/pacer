#![allow(clippy::unwrap_used)]
use super::*;
use std::{collections::HashMap, fs};

fn context() -> (tempfile::TempDir, Ctx) {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        tmp.path().join("home"),
        tmp.path().join("pacer"),
        HashMap::new(),
        0.0,
    );
    (tmp, ctx)
}

#[test]
fn existing_valid_level_does_not_rewrite_settings() {
    let (_tmp, ctx) = context();
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    let path = ctx.pacer_home.join("settings.json");
    let original = "{\"notifications\":\"all\",\"extra\":1}\n";
    fs::write(&path, original).unwrap();
    assert_eq!(notification_level(&ctx).unwrap(), json!({"level":"all"}));
    assert_eq!(fs::read_to_string(path).unwrap(), original);
}

#[test]
fn missing_or_invalid_level_migrates_legacy_then_defaults() {
    let (_tmp, ctx) = context();
    let legacy = legacy_settings(&ctx);
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, "{\"notifications\":\"off\"}").unwrap();
    assert_eq!(notification_level(&ctx).unwrap(), json!({"level":"off"}));
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("settings.json")).unwrap(),
        "{\"notifications\":\"off\"}"
    );
    fs::remove_file(&legacy).unwrap();
    fs::write(
        ctx.pacer_home.join("settings.json"),
        "{\"extra\":1,\"notifications\":\"invalid\"}",
    )
    .unwrap();
    assert_eq!(
        notification_level(&ctx).unwrap(),
        json!({"level":"important"})
    );
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("settings.json")).unwrap(),
        "{\"extra\":1,\"notifications\":\"important\"}"
    );
}

#[test]
fn legacy_location_respects_orca_user_data_override() {
    let (_tmp, mut ctx) = context();
    let orca = ctx.home.join("own-orca-profile");
    ctx.env.insert(
        "PACER_ORCA_USER_DATA".into(),
        orca.to_string_lossy().into_owned(),
    );
    let legacy = legacy_settings(&ctx);
    assert!(legacy.starts_with(&orca));
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(legacy, "{\"notifications\":\"off\"}").unwrap();
    assert_eq!(notification_level(&ctx).unwrap(), json!({"level":"off"}));
}

#[tokio::test]
async fn rejects_non_object_parameters_without_touching_disk() {
    let (_tmp, ctx) = context();
    let result = (ops()[0].call)(&ctx, Value::Array(Vec::new())).await;
    assert_eq!(result.unwrap_err().code, Code::InvalidInput);
    assert!(!ctx.pacer_home.join("settings.json").exists());
}

#[test]
fn typescript_notification_goldens_match_result_and_file_bytes() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/notifications-get.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let (_tmp, mut ctx) = context();
        let orca = ctx.home.join("orca-profile");
        ctx.env.insert(
            "PACER_ORCA_USER_DATA".into(),
            orca.to_string_lossy().into_owned(),
        );
        let settings = ctx.pacer_home.join("settings.json");
        if let Some(before) = case.get("settings").and_then(Value::as_str) {
            fs::create_dir_all(&ctx.pacer_home).unwrap();
            fs::write(&settings, before).unwrap();
        }
        if let Some(before) = case.get("legacy").and_then(Value::as_str) {
            let path = legacy_settings(&ctx);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, before).unwrap();
        }
        assert_eq!(
            notification_level(&ctx).unwrap(),
            case["result"],
            "{}",
            case["name"]
        );
        assert_eq!(
            fs::read_to_string(settings).unwrap(),
            case["after"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn string_spread_result_is_stable_on_repeated_reads() {
    let (_tmp, ctx) = context();
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    let settings = ctx.pacer_home.join("settings.json");
    fs::write(&settings, "\"😀\"").unwrap();
    assert_eq!(
        notification_level(&ctx).unwrap(),
        json!({"level":"important"})
    );
    let first = fs::read(&settings).unwrap();
    assert!(requires_core_parser(&ctx));
    assert_eq!(fs::read(&settings).unwrap(), first);
}

#[cfg(unix)]
#[test]
fn string_spread_uses_private_atomic_state_file_and_refuses_temp_collision() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, ctx) = context();
    let settings = ctx.pacer_home.join("settings.json");
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    fs::write(&settings, "\"😀\"").unwrap();
    let mut temp = settings.as_os_str().to_os_string();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp = PathBuf::from(temp);
    fs::write(&temp, b"collision").unwrap();
    let error = notification_level(&ctx).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(fs::read(&temp).unwrap(), b"collision");
    assert_eq!(fs::read(&settings).unwrap(), "\"😀\"".as_bytes());
    fs::remove_file(temp).unwrap();
    notification_level(&ctx).unwrap();
    assert_eq!(
        fs::metadata(&settings).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&ctx.pacer_home).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[cfg(unix)]
#[test]
fn default_object_write_is_private_and_refuses_temp_collision() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, ctx) = context();
    let settings = ctx.pacer_home.join("settings.json");
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    let mut temp = settings.as_os_str().to_os_string();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp = PathBuf::from(temp);
    fs::write(&temp, b"collision").unwrap();
    let error = notification_level(&ctx).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(fs::read(&temp).unwrap(), b"collision");
    assert!(!settings.exists());
    fs::remove_file(temp).unwrap();
    notification_level(&ctx).unwrap();
    assert_eq!(
        fs::metadata(&settings).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&ctx.pacer_home).unwrap().permissions().mode() & 0o777,
        0o700
    );
}
