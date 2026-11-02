#![allow(clippy::unwrap_used)]
#![allow(clippy::result_large_err)] // Exercises the public CoreError operation boundary.
use pacer_foundation::{Ctx, api::Code};
use pacer_plugin_ops::{publishers::PublisherTrust, settings};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    sync::{Arc, Barrier},
};

fn fixture() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(root.clone(), root, Default::default(), 0.0);
    (dir, ctx)
}

#[test]
fn publisher_store_decoding_matches_typescript_raw_byte_matrix() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let rows: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/plugin-publisher-store-parity.json"
    ))
    .unwrap();
    for row in rows.as_array().unwrap() {
        let (_dir, ctx) = fixture();
        fs::create_dir(ctx.pacer_home.join("plugins")).unwrap();
        fs::set_permissions(
            ctx.pacer_home.join("plugins"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let file = ctx.pacer_home.join("plugins/publishers.json");
        let bytes = STANDARD.decode(row["base64"].as_str().unwrap()).unwrap();
        fs::write(&file, &bytes).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let err = PublisherTrust::new(Default::default())
            .unwrap()
            .lookup(&ctx, "Fixture")
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(err.code).unwrap(),
            row["error"]["code"],
            "{row}"
        );
        assert_eq!(
            err.message,
            row["error"]["message"].as_str().unwrap(),
            "{row}"
        );
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
}

#[test]
fn settings_compare_and_swap_serializes_independent_writers() {
    let (_dir, ctx) = fixture();
    let barrier = Arc::new(Barrier::new(8));
    let writers = (0..8)
        .map(|n| {
            let ctx = ctx.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                settings::save(&ctx, "fx-ui", json!({"writer":n}), 0.0)
            })
        })
        .collect::<Vec<_>>();
    let results = writers
        .into_iter()
        .map(|w| w.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    for error in results.into_iter().filter_map(Result::err) {
        assert_eq!(error.code, Code::Conflict, "{error:?}");
        assert_eq!(
            error.message,
            "plugin fx-ui settings are at revision 1, not 0"
        );
    }
    assert_eq!(
        settings::read(&ctx, "fx-ui").unwrap()["rev"].as_f64(),
        Some(1.0)
    );
    assert_eq!(
        fs::metadata(ctx.pacer_home.join("plugin-settings.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(ctx.pacer_home.join("orca"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn settings_replace_linked_stores_but_refuse_redirected_locks_and_strategy() {
    let (_dir, ctx) = fixture();
    let outside = ctx.home.join("outside");
    fs::write(&outside, "untouched").unwrap();
    let store = ctx.pacer_home.join("plugin-settings.json");
    symlink(&outside, &store).unwrap();
    assert_eq!(
        settings::save(&ctx, "fx-ui", json!({}), 0.0).unwrap()["rev"],
        1
    );
    assert!(
        !fs::symlink_metadata(&store)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_file(&store).unwrap();
    fs::hard_link(&outside, &store).unwrap();
    assert_eq!(
        settings::save(&ctx, "fx-ui", json!({}), 0.0).unwrap()["rev"],
        1
    );
    fs::remove_file(store).unwrap();
    let lock = ctx.pacer_home.join("orca/plugin-settings.lock");
    symlink(&outside, &lock).unwrap();
    assert!(settings::save(&ctx, "fx-ui", json!({}), 0.0).is_err());
    fs::remove_file(lock).unwrap();
    let strategy = ctx.pacer_home.join("strategy.yaml");
    symlink(&outside, &strategy).unwrap();
    assert!(pacer_plugin_ops::public_config(&ctx).is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
}

#[test]
fn visibility_set_deduplicates_stored_hidden_keys_like_javascript_set() {
    let (_dir, ctx) = fixture();
    fs::write(
        ctx.pacer_home.join("plugin-settings.json"),
        r#"{"fx-ui":{"rev":0,"values":{},"hidden":["a","a","b"]}}"#,
    )
    .unwrap();
    let record = settings::visibility(&ctx, "fx-ui", "b", false, 0.0).unwrap();
    assert_eq!(record["hidden"], json!(["a", "b"]));
}

#[test]
fn publisher_store_uses_javascript_numeric_key_order_and_number_encoding() {
    let (_dir, ctx) = fixture();
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/plugin-archive-parity.json"
    ))
    .unwrap();
    let key = corpus["publicKey"].as_str().unwrap();
    let trust = PublisherTrust::new(Default::default()).unwrap();
    trust.set(&ctx, "10", Some(key), None).unwrap();
    trust.set(&ctx, "2", Some(key), None).unwrap();
    let file = ctx.pacer_home.join("plugins/publishers.json");
    let encoded = fs::read_to_string(&file).unwrap();
    assert!(encoded.find("\"2\"").unwrap() < encoded.find("\"10\"").unwrap());
    assert!(trust.lookup(&ctx, "2").unwrap().is_some());
    fs::write(
        &file,
        encoded.replacen("\"version\": 1", "\"version\": 1.0", 1),
    )
    .unwrap();
    assert_eq!(
        trust.lookup(&ctx, "2").unwrap_err().message,
        "invalid publisher store encoding"
    );
}

#[test]
fn settings_resolve_configured_home_and_lock_directory_aliases() {
    // No chdir: Rust tests run in parallel. Relative paths are rooted at the
    // current working directory exactly as TS filesystem operations are.
    for kind in [
        "symlink",
        "relative",
        "relative-symlink",
        "lock-symlink",
        "new-relative",
    ] {
        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let linked = dir.path().join("linked");
        symlink("real", &linked).unwrap();
        let path = match kind {
            "symlink" => linked,
            "relative" => real
                .strip_prefix(std::env::current_dir().unwrap())
                .unwrap()
                .to_path_buf(),
            "relative-symlink" => linked
                .strip_prefix(std::env::current_dir().unwrap())
                .unwrap()
                .to_path_buf(),
            "new-relative" => dir
                .path()
                .join("new/nested")
                .strip_prefix(std::env::current_dir().unwrap())
                .unwrap()
                .to_path_buf(),
            _ => {
                fs::create_dir(dir.path().join("locks")).unwrap();
                symlink("../locks", real.join("orca")).unwrap();
                real.clone()
            }
        };
        let lock_mode = fs::metadata(path.join("orca"))
            .ok()
            .map(|m| m.mode() & 0o777)
            .unwrap_or(0o700);
        let ctx = Ctx::with(dir.path().to_path_buf(), path, Default::default(), 0.0);
        assert_eq!(
            settings::save(&ctx, "fx-ui", json!({"ok":true}), 0.0).unwrap()["rev"],
            1,
            "{kind}"
        );
        assert_eq!(
            settings::visibility(&ctx, "fx-ui", "activity:checklist", false, 1.0).unwrap()["hidden"],
            json!(["activity:checklist"]),
            "{kind}"
        );
        assert_eq!(
            settings::read(&ctx, "fx-ui").unwrap()["values"],
            json!({"ok":true}),
            "{kind}"
        );
        settings::forget(&ctx, "fx-ui").unwrap();
        assert_eq!(settings::read(&ctx, "fx-ui").unwrap()["rev"], 0, "{kind}");
        assert_eq!(
            fs::metadata(ctx.pacer_home.join("plugin-settings.json"))
                .unwrap()
                .mode()
                & 0o777,
            0o600,
            "{kind}"
        );
        assert_eq!(
            fs::metadata(ctx.pacer_home.join("orca")).unwrap().mode() & 0o777,
            lock_mode,
            "{kind}"
        );
    }
}

#[test]
fn group_writable_home_and_lock_directory_are_preserved() {
    let (_dir, ctx) = fixture();
    let real = ctx.pacer_home.join("real");
    fs::create_dir(&real).unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o777)).unwrap();
    let linked = ctx.pacer_home.join("linked");
    symlink(&real, &linked).unwrap();
    let ctx = Ctx {
        pacer_home: linked,
        ..ctx
    };
    fs::create_dir(real.join("orca")).unwrap();
    fs::set_permissions(real.join("orca"), fs::Permissions::from_mode(0o775)).unwrap();
    assert_eq!(
        settings::save(&ctx, "fx-ui", json!({}), 0.0).unwrap()["rev"],
        1
    );
    assert_eq!(fs::metadata(&real).unwrap().mode() & 0o777, 0o777);
    assert_eq!(
        fs::metadata(real.join("orca")).unwrap().mode() & 0o777,
        0o775
    );
}
