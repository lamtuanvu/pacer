#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use pacer_foundation::Ctx;
use pacer_plugin_host::{
    archive,
    publishers::{PublisherTrust, fingerprint, key_bytes},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
fn ctx(dir: &tempfile::TempDir) -> Ctx {
    let root = dir.path().canonicalize().unwrap();
    Ctx::with(root.clone(), root, Default::default(), 0.0)
}
fn matrix() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/plugin-archive-parity.json"
    ))
    .unwrap()
}
#[test]
fn typescript_archive_inventory_and_signed_extraction() {
    let m = matrix();
    for case in m["entries"].as_array().unwrap() {
        let bytes = STANDARD.decode(case["base64"].as_str().unwrap()).unwrap();
        let result = archive::inspect(&bytes);
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.err().unwrap().message, error, "{}", case["name"]);
        } else {
            assert!(result.is_ok(), "{}", case["name"]);
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let trust = PublisherTrust::new(Default::default()).unwrap();
    let key = m["publicKey"].as_str().unwrap();
    trust.set(&ctx, "Fixture", Some(key), None).unwrap();
    let bytes = STANDARD
        .decode(m["entries"][0]["base64"].as_str().unwrap())
        .unwrap();
    let verified = archive::inspect(&bytes)
        .unwrap()
        .verify(&ctx, m["signature"].as_str().unwrap(), &trust)
        .unwrap();
    assert_eq!(verified.manifest().id.as_str(), "fx-archive");
    let out = ctx.home.join("stage");
    fs::create_dir(&out).unwrap();
    fs::set_permissions(&out, fs::Permissions::from_mode(0o700)).unwrap();
    verified.extract(&out).unwrap();
    assert_eq!(
        fs::read_to_string(out.join("main.js")).unwrap(),
        "#!/usr/bin/env bun\n"
    );
    assert_eq!(
        fs::metadata(out.join("main.js"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(out.join("pacer-plugin.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(verified.extract(&out).is_err());
    let link = ctx.home.join("link");
    symlink(&out, &link).unwrap();
    assert!(verified.extract(&link).is_err());
    assert!(
        archive::inspect(&bytes)
            .unwrap()
            .verify(
                &ctx,
                &format!("{}\n", m["signature"].as_str().unwrap()),
                &trust
            )
            .is_err()
    );
    let other = PublisherTrust::new(Default::default()).unwrap();
    let unknown = tempfile::tempdir().unwrap();
    assert!(
        archive::inspect(&bytes)
            .unwrap()
            .verify(
                &super_ctx(&unknown),
                m["signature"].as_str().unwrap(),
                &other
            )
            .is_err()
    );
}
fn super_ctx(dir: &tempfile::TempDir) -> Ctx {
    ctx(dir)
}
#[test]
fn publisher_cas_collision_modes_and_redirects() {
    let m = matrix();
    let key = m["publicKey"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let trust = PublisherTrust::new(Default::default()).unwrap();
    assert!(trust.lookup(&ctx, "Fixture").unwrap().is_none());
    let result = trust.set(&ctx, "Fixture", Some(key), None).unwrap();
    assert_eq!(result, json!({"fingerprint":fingerprint(key).unwrap()}));
    assert!(trust.set(&ctx, "Fixture", Some(key), None).is_err());
    assert!(trust.set(&ctx, "fixture", Some(key), None).is_err());
    assert_eq!(
        trust.lookup(&ctx, "Fixture").unwrap().unwrap()["source"],
        "user"
    );
    assert_eq!(
        fs::metadata(ctx.pacer_home.join("plugins"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let path = ctx.pacer_home.join("plugins/publishers.json");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(trust.lookup(&ctx, "Fixture").is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let fp = fingerprint(key).unwrap();
    trust.set(&ctx, "Fixture", None, Some(&fp)).unwrap();
    assert!(trust.lookup(&ctx, "Fixture").unwrap().is_none());
    fs::remove_file(&path).unwrap();
    let target = ctx.home.join("outside");
    fs::write(&target, "untouched").unwrap();
    symlink(&target, &path).unwrap();
    assert!(trust.set(&ctx, "Fixture", Some(key), None).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
    for weak in [
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ] {
        assert!(key_bytes(weak).is_err());
    }
    let shipped = PublisherTrust::new(std::collections::BTreeMap::from([(
        "Fixture".into(),
        key.into(),
    )]))
    .unwrap();
    assert!(shipped.set(&ctx, "Fixture", Some(key), None).is_err());
    assert!(shipped.set(&ctx, "fixture", Some(key), None).is_err());
}

#[test]
fn signature_encoding_matrix() {
    let m = matrix();
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let trust = PublisherTrust::new(std::collections::BTreeMap::from([(
        "Fixture".into(),
        m["publicKey"].as_str().unwrap().into(),
    )]))
    .unwrap();
    let bytes = STANDARD
        .decode(m["entries"][0]["base64"].as_str().unwrap())
        .unwrap();
    for row in m["signatures"].as_array().unwrap() {
        let result = archive::inspect(&bytes).unwrap().verify(
            &ctx,
            row["signature"].as_str().unwrap(),
            &trust,
        );
        assert_eq!(
            result.err().map(|e| e.message),
            row["error"].as_str().map(str::to_owned),
            "{row}"
        );
    }
}
