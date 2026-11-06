#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap as Items;

/// A `security` stand-in like test/fake-keychain.ts: items keyed by service and account.
#[derive(Default)]
struct FakeKeychain {
    items: Mutex<Items<String, Vec<u8>>>,
    fail_write: Mutex<Option<String>>,
}

fn flag<'a>(args: &[&'a str], name: &str) -> &'a str {
    args.iter()
        .position(|a| *a == name)
        .and_then(|i| args.get(i + 1))
        .copied()
        .unwrap_or("")
}

impl Security for FakeKeychain {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> (i32, String) {
        if args == ["-i"] {
            let line = stdin.unwrap_or("").trim_end();
            let words: Vec<&str> = line.split(' ').collect();
            let account = flag(&words, "-a");
            if self
                .fail_write
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|f| account.starts_with(f))
            {
                return (0, String::new());
            }
            let key = format!("{}|{account}", flag(&words, "-s"));
            self.items
                .lock()
                .unwrap()
                .insert(key, hex::decode(flag(&words, "-X")).unwrap());
            return (0, String::new());
        }
        let key = format!("{}|{}", flag(args, "-s"), flag(args, "-a"));
        let mut items = self.items.lock().unwrap();
        match args[0] {
            "find-generic-password" => match items.get(&key) {
                None => (44, String::new()),
                Some(v) if v.iter().all(|b| (0x20..0x7f).contains(b)) => {
                    (0, format!("{}\n", String::from_utf8_lossy(v)))
                }
                Some(v) => (0, format!("{}\n", hex::encode(v))),
            },
            "delete-generic-password" => {
                if items.remove(&key).is_some() {
                    (0, String::new())
                } else {
                    (44, String::new())
                }
            }
            _ => (1, String::new()),
        }
    }
}

struct NoKeychain;
impl Security for NoKeychain {
    fn run(&self, _: &[&str], _: Option<&str>) -> (i32, String) {
        (127, String::new())
    }
}

fn file_env() -> Env<'static> {
    Env {
        keychain: false,
        security: &NoKeychain,
    }
}

fn ctx_at(home: &Path) -> Ctx {
    Ctx::with(
        home.into(),
        home.join(".pacer"),
        Default::default(),
        1_700_000_000.0,
    )
}

fn meta_text(ctx: &Ctx) -> String {
    fs::read_to_string(meta_path(ctx)).unwrap()
}

#[test]
fn base32_matches_rfc4648_lowercase_unpadded() {
    assert_eq!(base32(b""), "");
    assert_eq!(base32(b"f"), "my");
    assert_eq!(base32(b"foobar"), "mzxw6ytboi");
}

#[test]
fn first_load_creates_a_file_identity_with_typescript_layout() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(dir.path());
    let view = machine_get(&ctx, &file_env()).unwrap();
    let id = view["id"].as_str().unwrap();
    assert_eq!(id.len(), 52);
    assert_eq!(view["rev"], 1);
    assert_eq!(view["cloneSuspected"], false);
    let der = fs::read(key_path(&ctx, Slot::Current)).unwrap();
    assert_eq!(der.len(), 48);
    assert_eq!(der[..16], PKCS8_V1_PREFIX);
    let salt = fs::read_to_string(salt_path(&ctx)).unwrap();
    assert_eq!(salt.len(), 65);
    let name = view["name"].as_str().unwrap();
    assert!(name.starts_with("pacer-") && name.len() == 10);
    assert_eq!(
        meta_text(&ctx),
        format!(
            "{{\n  \"rev\": 1,\n  \"name\": \"{name}\",\n  \"createdAt\": 1700000000,\n  \"backend\": \"file\",\n  \"saltHash\": \"{}\",\n  \"publicId\": \"{id}\"\n}}\n",
            salt_hash(salt.trim())
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&meta_path(&ctx)), 0o600);
        assert_eq!(mode(&ctx.pacer_home.join("identity")), 0o700);
    }
    assert_eq!(machine_get(&ctx, &file_env()).unwrap(), view);
}

#[test]
fn rename_checks_revision_and_sanitizes() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(dir.path());
    let view = machine_get(&ctx, &file_env()).unwrap();
    let renamed = machine_set(&ctx, &file_env(), " \u{202e}studio\u{0007}-mac ", 1).unwrap();
    assert_eq!(renamed["name"], "studio-mac");
    assert_eq!(renamed["rev"], 2);
    assert_eq!(renamed["id"], view["id"]);
    let conflict = machine_set(&ctx, &file_env(), "x", 1).unwrap_err();
    assert_eq!(conflict.code, Code::Conflict);
    assert_eq!(conflict.message, "Machine name changed in another client");
    assert_eq!(conflict.hint.as_deref(), Some("Reload and try again."));
    assert_eq!(json!(conflict.data), json!({"expected":1,"actual":2}));
    let empty = machine_set(&ctx, &file_env(), "\u{200b}\u{feff}", 2).unwrap_err();
    assert_eq!(empty.message, "Machine name is empty");
    assert_eq!(empty.hint.as_deref(), Some("Use 1-64 visible characters."));
    let long = machine_set(&ctx, &file_env(), &"é".repeat(80), 2).unwrap();
    assert_eq!(long["name"].as_str().unwrap().chars().count(), 64);
}

#[test]
fn copied_file_home_without_its_salt_is_flagged() {
    let dir = tempfile::tempdir().unwrap();
    let a = ctx_at(&dir.path().join("a"));
    let original = machine_get(&a, &file_env()).unwrap();
    let b = ctx_at(&dir.path().join("b"));
    fs::create_dir_all(b.pacer_home.join("identity")).unwrap();
    for file in ["machine.json", "machine.key"] {
        fs::copy(
            a.pacer_home.join("identity").join(file),
            b.pacer_home.join("identity").join(file),
        )
        .unwrap();
    }
    let copy = machine_get(&b, &file_env()).unwrap();
    assert_eq!(copy["id"], original["id"]);
    assert_eq!(copy["cloneSuspected"], true);
    let meta = read_meta(&b).unwrap().unwrap();
    assert_eq!(meta["cloneDetected"], true);
    assert_eq!(meta["cloneDetectedAt"], 1_700_000_000);
    assert_eq!(
        machine_get(&a, &file_env()).unwrap()["cloneSuspected"],
        false
    );
}

fn verify(old_id: &str, new_id: &str, signature: &str) -> bool {
    let raw = decode_base32(old_id);
    let sig =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, signature).unwrap();
    let message = rotate_message(old_id, new_id);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, raw)
        .verify(&message, &sig)
        .is_ok()
}

fn rotate_message(old_id: &str, new_id: &str) -> Vec<u8> {
    format!("pacer-machine-sig/v1\0pacer\0rotate\0{old_id}\0{new_id}").into_bytes()
}

fn decode_base32(text: &str) -> Vec<u8> {
    let (mut out, mut bits, mut value) = (Vec::new(), 0u32, 0u32);
    for c in text.bytes() {
        let i = ALPHABET.iter().position(|a| *a == c).unwrap() as u32;
        value = ((value << 5) | i) & 0xffff;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    out
}

#[test]
fn rotation_commits_signs_audits_and_announces() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(dir.path());
    let before = machine_get(&ctx, &file_env()).unwrap();
    fs::write(
        ctx.pacer_home.join("identity/transport-keys.json"),
        "{\"p\":\"x\"}\n",
    )
    .unwrap();
    let r = rotate(&ctx, &file_env()).unwrap();
    assert_eq!(
        r.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["oldId", "newId"]
    );
    assert_eq!(r["oldId"], before["id"]);
    let after = machine_get(&ctx, &file_env()).unwrap();
    assert_eq!(after["id"], r["newId"]);
    assert_eq!(after["rev"], 2);
    assert_eq!(after["rotatedFrom"], r["oldId"]);
    let sig = after["rotationSignature"].as_str().unwrap();
    assert!(verify(
        r["oldId"].as_str().unwrap(),
        r["newId"].as_str().unwrap(),
        sig
    ));
    let meta = read_meta(&ctx).unwrap().unwrap();
    assert_eq!(
        meta.keys().collect::<Vec<_>>(),
        [
            "rev",
            "name",
            "createdAt",
            "backend",
            "saltHash",
            "publicId",
            "rotatedFrom",
            "lastRotation"
        ]
    );
    assert!(!key_path(&ctx, Slot::Staging).exists());
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("identity/transport-keys.json")).unwrap(),
        "{}\n"
    );
    let audit = fs::read_to_string(ctx.pacer_home.join("logs/identity-audit.jsonl")).unwrap();
    let line: Value = serde_json::from_str(audit.trim()).unwrap();
    assert_eq!(
        line.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "at",
            "pluginId",
            "purpose",
            "sha256",
            "outcome",
            "machineId"
        ]
    );
    assert_eq!(line["machineId"], r["oldId"]);
    let activity = fs::read_to_string(ctx.pacer_home.join("state/activity.jsonl")).unwrap();
    assert!(activity.contains("Machine identity rotated ("));
    let outbox = fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl")).unwrap();
    assert!(outbox.contains("\"kind\":\"machine\",\"id\":\"self\""));
}

#[test]
fn copied_home_rotation_clears_the_flag() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(dir.path());
    machine_get(&ctx, &file_env()).unwrap();
    fs::remove_file(salt_path(&ctx)).unwrap();
    clear_cache();
    assert_eq!(
        machine_get(&ctx, &file_env()).unwrap()["cloneSuspected"],
        true
    );
    rotate(&ctx, &file_env()).unwrap();
    assert_eq!(
        machine_get(&ctx, &file_env()).unwrap()["cloneSuspected"],
        false
    );
    assert!(
        read_meta(&ctx)
            .unwrap()
            .unwrap()
            .get("cloneDetected")
            .is_none()
    );
}

fn pending_state(ctx: &Ctx, staged: bool) -> (String, String) {
    let env = file_env();
    let old = machine_get(ctx, &env).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let key = Key::generate().unwrap();
    let mut meta = read_meta(ctx).unwrap().unwrap();
    meta.insert(
        "pendingRotation".into(),
        json!({"oldId":old,"newId":key.id,"signature":"c2ln","stagedAt":1,"saltHash":"none"}),
    );
    write_meta(ctx, &meta).unwrap();
    if staged {
        write_private_key(ctx, &env, false, &key, Slot::Staging).unwrap();
    }
    (old, key.id)
}

#[test]
fn load_completes_a_staged_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(dir.path());
    let (old, new) = pending_state(&ctx, true);
    let view = machine_get(&ctx, &file_env()).unwrap();
    assert_eq!(view["id"], new.as_str());
    assert_eq!(view["rotatedFrom"], old.as_str());
    assert!(!key_path(&ctx, Slot::Staging).exists());
    let meta = read_meta(&ctx).unwrap().unwrap();
    assert!(meta.get("pendingRotation").is_none());
    assert_eq!(
        meta["saltHash"],
        json!(salt_hash(js_trim(
            &fs::read_to_string(salt_path(&ctx)).unwrap()
        )))
    );
}

#[test]
fn load_rolls_back_a_rotation_whose_key_never_landed() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(dir.path());
    let (old, _) = pending_state(&ctx, false);
    let view = machine_get(&ctx, &file_env()).unwrap();
    assert_eq!(view["id"], old.as_str());
    assert!(view.get("rotatedFrom").is_none());
    assert!(
        read_meta(&ctx)
            .unwrap()
            .unwrap()
            .get("pendingRotation")
            .is_none()
    );
}

#[test]
fn keychain_backend_uses_per_home_accounts_and_detects_a_moved_home() {
    let dir = tempfile::tempdir().unwrap();
    let kc = FakeKeychain::default();
    let env = Env {
        keychain: true,
        security: &kc,
    };
    let a = ctx_at(&dir.path().join("a"));
    let view = machine_get(&a, &env).unwrap();
    let tag = home_tag(&a);
    let items = kc
        .items
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        items.into_iter().collect::<Vec<_>>(),
        [
            format!("pacer|machine-identity/{tag}"),
            format!("pacer|machine-install-salt/{tag}")
        ]
    );
    assert!(!key_path(&a, Slot::Current).exists());
    assert!(meta_text(&a).contains("\"backend\": \"keychain\""));
    let b = ctx_at(&dir.path().join("b"));
    fs::create_dir_all(b.pacer_home.join("identity")).unwrap();
    fs::copy(meta_path(&a), meta_path(&b)).unwrap();
    let copy = machine_get(&b, &env).unwrap();
    assert_eq!(copy["cloneSuspected"], true);
    assert_ne!(copy["id"], view["id"]);
    assert_eq!(copy["rev"], 2);
    clear_cache();
    assert_eq!(machine_get(&a, &env).unwrap(), view);
    let r = rotate(&b, &env).unwrap();
    assert_eq!(machine_get(&b, &env).unwrap()["id"], r["newId"]);
    assert_eq!(machine_get(&b, &env).unwrap()["cloneSuspected"], false);
}

#[test]
fn failed_keychain_staging_restores_the_old_identity() {
    let dir = tempfile::tempdir().unwrap();
    let kc = FakeKeychain::default();
    let env = Env {
        keychain: true,
        security: &kc,
    };
    let ctx = ctx_at(dir.path());
    let before = machine_get(&ctx, &env).unwrap();
    let meta = meta_text(&ctx);
    *kc.fail_write.lock().unwrap() = Some("machine-identity-staging/".into());
    let error = rotate(&ctx, &env).unwrap_err();
    assert_eq!(error.message, "machine identity keychain write failed");
    assert_eq!(meta_text(&ctx), meta);
    assert_eq!(machine_get(&ctx, &env).unwrap(), before);
}

#[test]
fn keychain_read_failure_is_an_error_not_a_copy() {
    struct Broken;
    impl Security for Broken {
        fn run(&self, _: &[&str], _: Option<&str>) -> (i32, String) {
            (1, String::new())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let env = Env {
        keychain: true,
        security: &Broken,
    };
    let error = machine_get(&ctx_at(dir.path()), &env).unwrap_err();
    assert_eq!(error.code, Code::Internal);
    assert_eq!(error.message, "machine identity keychain read failed");
}

#[test]
fn home_tag_is_stable_before_and_after_creation() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_at(&dir.path().join("x/../y"));
    let before = home_tag(&ctx);
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    assert_eq!(home_tag(&ctx), before);
    let canonical = fs::canonicalize(dir.path()).unwrap().join("y/.pacer");
    let mut hasher = Sha256::new();
    hasher.update(format!("pacer-home/v1\0{}", canonical.display()));
    assert_eq!(before, hex::encode(hasher.finalize())[..16]);
}
