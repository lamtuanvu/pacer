#![allow(clippy::unwrap_used)]
#![allow(clippy::result_large_err)] // Exercises the public CoreError operation boundary.
use pacer_foundation::{Ctx, api::Code};
use pacer_plugin_host::{publishers::PublisherTrust, settings};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::{Arc, Barrier},
};

fn fixture() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(root.clone(), root, Default::default(), 0.0);
    (dir, ctx)
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
        assert_eq!(error.code, Code::Conflict);
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
    assert!(pacer_plugin_host::public_config(&ctx).is_err());
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
