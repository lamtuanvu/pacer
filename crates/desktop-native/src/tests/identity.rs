#![allow(clippy::unwrap_used)]
//! Port of `test/desktop-update-identity.test.ts`. Builds a real on-disk
//! front-door bundle and registration exactly as the TS fixture does, then
//! exercises `inspect_installation` and `verify_installation`.
use super::*;

use serde_json::{Value, json};
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

const RELEASE_VERSION: &str = "1.2.3";

fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    }
}

fn base_release(paired: bool) -> Value {
    let mut v = json!({
        "schema": 1,
        "bundleId": "dev.pacer.desktop",
        "version": RELEASE_VERSION,
        "arch": host_arch(),
        "protocolMajors": [3],
        "admissionProtocol": 1,
        "rollbackCompatible": true,
        "nativeTransportAbi": 1,
    });
    if paired {
        v["cliLayout"] = json!("paired");
    }
    v
}

fn write_pristine(path: &Path, mode: u32) {
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all("executable fixture".as_bytes()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// The exact plist the front door writes for `plist(ctx, [cli])` with
/// `PACER_PORT=54321`. Pascal-style path values are plain here (no XML
/// escaping needed for temp paths).
fn plist_text(home: &str, pacer_home: &str, port: &str, cli: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<!-- pacer -->\n\
<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>com.pacer.serve</string>\n\
<key>ProgramArguments</key><array><string>{cli}</string><string>serve</string></array>\n\
<key>EnvironmentVariables</key><dict><key>HOME</key><string>{home}</string><key>PATH</key><string>/usr/local/bin:/usr/bin</string><key>PACER_HOME</key><string>{pacer_home}</string><key>PACER_PORT</key><string>{port}</string></dict>\n\
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Standard</string>\n\
<key>StandardOutPath</key><string>{pacer_home}/logs/serve.log</string><key>StandardErrorPath</key><string>{pacer_home}/logs/serve.log</string>\n\
</dict></plist>\n"
    )
}

struct Fx {
    _dir: tempfile::TempDir,
    home: PathBuf,
    pacer_home: PathBuf,
    app: PathBuf,
    cli: PathBuf,
    registration: PathBuf,
    inputs: InspectInputs,
}

fn fixture(paired: bool) -> Fx {
    let dir = tempfile::TempDir::new().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let home = base.join("home");
    let pacer_home = base.join("state");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&pacer_home).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&pacer_home, std::fs::Permissions::from_mode(0o755)).unwrap();

    let app_dir = home.join("Applications/pacer.app");
    std::fs::create_dir_all(app_dir.join("Contents/Resources")).unwrap();
    std::fs::create_dir_all(app_dir.join("Contents/MacOS")).unwrap();
    for d in [app_dir.join("Contents").as_path(), app_dir.as_path()] {
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let cli = app_dir.join("Contents/Resources/pacer");
    write_pristine(&cli, 0o755);
    write_pristine(
        &app_dir.join("Contents/Resources/pacer-update-helper"),
        0o755,
    );
    write_pristine(&app_dir.join("Contents/MacOS/pacer"), 0o755);

    let release_path = app_dir.join("Contents/Resources/pacer-release.json");
    let mut f = std::fs::File::create(&release_path).unwrap();
    f.write_all(base_release(paired).to_string().as_bytes())
        .unwrap();
    std::fs::set_permissions(&release_path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let info = format!(
        "<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>dev.pacer.desktop</string>\
<key>CFBundleShortVersionString</key><string>{}</string><key>CFBundleExecutable</key><string>pacer</string></dict></plist>",
        RELEASE_VERSION
    );
    let info_path = app_dir.join("Contents/Info.plist");
    std::fs::write(&info_path, info).unwrap();
    std::fs::set_permissions(&info_path, std::fs::Permissions::from_mode(0o644)).unwrap();

    if paired {
        write_pristine(&app_dir.join("Contents/Resources/pacer-core"), 0o755);
    }

    let registration = service_registration_path(&home);
    std::fs::create_dir_all(registration.parent().unwrap()).unwrap();
    std::fs::set_permissions(
        registration.parent().unwrap(),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let text = plist_text(
        home.to_str().unwrap(),
        pacer_home.to_str().unwrap(),
        "54321",
        cli.to_str().unwrap(),
    );
    std::fs::write(&registration, text).unwrap();
    std::fs::set_permissions(&registration, std::fs::Permissions::from_mode(0o644)).unwrap();

    Fx {
        _dir: dir,
        home: home.clone(),
        pacer_home: pacer_home.clone(),
        app: app_dir,
        cli,
        registration,
        inputs: InspectInputs {
            pacer_home,
            user_home: home,
            port_env: Some("54321".to_owned()),
        },
    }
}

#[test]
fn trusted_registration_canonicalizes_app_aliases_and_binds_full_service_identity() {
    let f = fixture(false);
    let alias = f.home.join("alias.app");
    symlink(&f.app, &alias).unwrap();

    let identity = inspect_installation(&f.inputs, &alias).unwrap();
    assert_eq!(identity.app_path, std::fs::canonicalize(&f.app).unwrap());
    assert_eq!(identity.owner_uid, nix::unistd::getuid().as_raw() as u64);
    assert_eq!(
        identity.pacer_home,
        std::fs::canonicalize(&f.pacer_home).unwrap()
    );
    assert_eq!(identity.port, 54321);
    assert_eq!(identity.ownership, "managed");
    assert_eq!(identity.version, RELEASE_VERSION);
    assert_eq!(identity.bundle_id, "dev.pacer.desktop");
    verify_installation(&f.inputs, &identity).unwrap();

    assert!(is_bundled_executable(&f.cli));
    let bin_alias = f.home.join("pacer");
    symlink(&f.cli, &bin_alias).unwrap();
    assert!(is_bundled_executable(&bin_alias));
    assert!(!is_bundled_executable(&std::env::current_exe().unwrap()));
}

#[test]
fn independent_registered_binary_stays_attached_and_is_never_executed_or_adopted() {
    let f = fixture(false);
    let external = f.home.join("old-pacer");
    write_pristine(&external, 0o755);
    let text = plist_text(
        f.home.to_str().unwrap(),
        f.pacer_home.to_str().unwrap(),
        "54321",
        external.to_str().unwrap(),
    );
    std::fs::write(&f.registration, text).unwrap();
    let before = std::fs::read_to_string(&f.registration).unwrap();
    let identity = inspect_installation(&f.inputs, &f.app).unwrap();
    assert_eq!(identity.ownership, "attached");
    assert_eq!(std::fs::read_to_string(&f.registration).unwrap(), before);
}

#[test]
fn wrong_home_port_argv_label_and_ambiguous_plist_fail_without_mutation() {
    for label in [
        "port",
        "home",
        "pacer_home",
        "argv_conflict",
        "argv_src",
        "label",
        "extra_key",
        "duplicate_label",
    ] {
        let f = fixture(false);
        let home = f.home.to_str().unwrap();
        let pacer_home = f.pacer_home.to_str().unwrap();
        let original = std::fs::read_to_string(&f.registration).unwrap();
        let text = match label {
            "port" => original.replace("<string>54321</string>", "<string>54322</string>"),
            "home" => original.replace(
                &format!("<key>HOME</key><string>{home}</string>"),
                "<key>HOME</key><string>/another-home</string>",
            ),
            "pacer_home" => original.replace(
                &format!("<key>PACER_HOME</key><string>{pacer_home}</string>"),
                "<key>PACER_HOME</key><string>/another-state</string>",
            ),
            "argv_conflict" => original.replace(
                "<string>serve</string>",
                "<string>serve</string><string>--port</string><string>54322</string>",
            ),
            "argv_src" => original.replace(
                "<string>serve</string>",
                "<string>src/cli.ts</string><string>serve</string>",
            ),
            "label" => original.replace(
                "<string>com.pacer.serve</string>",
                "<string>other.service</string>",
            ),
            "extra_key" => original.replace(
                "<key>ProgramArguments</key>",
                "<key>Program</key><string>/different</string><key>ProgramArguments</key>",
            ),
            "duplicate_label" => original.replace(
                "<key>Label</key>",
                "<key>Label</key><string>duplicate</string><key>Label</key>",
            ),
            _ => unreachable!(),
        };
        std::fs::write(&f.registration, &text).unwrap();
        assert!(inspect_installation(&f.inputs, &f.app).is_err(), "{label}");
        assert_eq!(
            std::fs::read_to_string(&f.registration).unwrap(),
            text,
            "{label}"
        );
    }
}

#[test]
fn verification_detects_changed_uid_home_port_version_and_moved_or_swapped_app() {
    let f = fixture(false);
    let identity = inspect_installation(&f.inputs, &f.app).unwrap();

    let mut changed = identity.clone();
    changed.owner_uid = identity.owner_uid + 1;
    assert!(verify_installation(&f.inputs, &changed).is_err());

    let tmp = tempfile::TempDir::new().unwrap();
    let mut changed = identity.clone();
    changed.pacer_home = tmp.path().to_owned();
    assert!(verify_installation(&f.inputs, &changed).is_err());

    let mut changed = identity.clone();
    changed.port = 1;
    assert!(verify_installation(&f.inputs, &changed).is_err());

    let mut changed = identity.clone();
    changed.version = "9.0.0".to_owned();
    assert!(verify_installation(&f.inputs, &changed).is_err());

    let mut changed = identity.clone();
    changed.id = "another-installation".to_owned();
    assert!(verify_installation(&f.inputs, &changed).is_err());

    let moved = PathBuf::from(format!("{}-moved", f.app.display()));
    std::fs::rename(&f.app, &moved).unwrap();
    symlink(&moved, &f.app).unwrap();
    assert!(verify_installation(&f.inputs, &identity).is_err());
}

#[test]
fn read_only_destinations_symlinked_payloads_and_missing_metadata_refuse_eligibility() {
    for mode in ["parent", "payload", "metadata", "registration"] {
        let f = fixture(false);
        match mode {
            "parent" => {
                std::fs::set_permissions(
                    f.app.parent().unwrap(),
                    std::fs::Permissions::from_mode(0o555),
                )
                .unwrap();
            }
            "payload" => {
                std::fs::remove_file(&f.cli).unwrap();
                symlink(std::env::current_exe().unwrap(), &f.cli).unwrap();
            }
            "metadata" => {
                std::fs::remove_file(f.app.join("Contents/Resources/pacer-release.json")).unwrap();
            }
            "registration" => {
                let real = PathBuf::from(format!("{}.real", f.registration.display()));
                std::fs::rename(&f.registration, &real).unwrap();
                symlink(&real, &f.registration).unwrap();
            }
            _ => {}
        }
        assert!(inspect_installation(&f.inputs, &f.app).is_err(), "{mode}");
        if mode == "parent" {
            std::fs::set_permissions(
                f.app.parent().unwrap(),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
    }
}

#[test]
fn bundle_metadata_fails_closed_on_unsupported_admission_architecture_and_schema() {
    let mut additive = base_release(false).as_object().unwrap().clone();
    additive.insert("additive".into(), json!(true));
    let parsed = parse_bundle_release(&Value::Object(additive)).unwrap();
    assert_eq!(parsed.version, RELEASE_VERSION);

    for patch in [
        nta_missing,
        nta_two,
        schema_two,
        admission_zero,
        arch_universal,
        rollback_false,
        version_latest,
        bundle_other,
        no_majors,
    ] {
        let mut v = base_release(false).as_object().unwrap().clone();
        patch(&mut v);
        assert!(parse_bundle_release(&Value::Object(v)).is_err());
    }
}

fn mode_without(v: &mut serde_json::Map<String, Value>, key: &str) {
    v.remove(key);
}
fn nta_missing(v: &mut serde_json::Map<String, Value>) {
    mode_without(v, "nativeTransportAbi");
}
fn nta_two(v: &mut serde_json::Map<String, Value>) {
    v.insert("nativeTransportAbi".into(), json!(2));
}
fn schema_two(v: &mut serde_json::Map<String, Value>) {
    v.insert("schema".into(), json!(2));
}
fn admission_zero(v: &mut serde_json::Map<String, Value>) {
    v.insert("admissionProtocol".into(), json!(0));
}
fn arch_universal(v: &mut serde_json::Map<String, Value>) {
    v.insert("arch".into(), json!("universal"));
}
fn rollback_false(v: &mut serde_json::Map<String, Value>) {
    v.insert("rollbackCompatible".into(), json!(false));
}
fn version_latest(v: &mut serde_json::Map<String, Value>) {
    v.insert("version".into(), json!("latest"));
}
fn bundle_other(v: &mut serde_json::Map<String, Value>) {
    v.insert("bundleId".into(), json!("other.app"));
}
fn no_majors(v: &mut serde_json::Map<String, Value>) {
    v.insert("protocolMajors".into(), json!([]));
}

#[test]
fn paired_layout_metadata_is_retained_and_rejects_unsupported_layouts() {
    let mut raw = base_release(true).as_object().unwrap().clone();
    let parsed = parse_bundle_release(&Value::Object(raw.clone())).unwrap();
    assert_eq!(parsed.cli_layout.as_deref(), Some("paired"));
    for value in [json!("single"), json!("other"), Value::Null, json!(1)] {
        raw.insert("cliLayout".into(), value);
        assert!(parse_bundle_release(&Value::Object(raw.clone())).is_err());
    }
}

#[test]
fn paired_installations_require_an_owned_executable_nonredirected_core() {
    for mode in ["missing", "nonexecutable", "symlink", "valid"] {
        let f = fixture(true);
        let core = f.app.join("Contents/Resources/pacer-core");
        match mode {
            "missing" => std::fs::remove_file(&core).unwrap(),
            "symlink" => {
                std::fs::remove_file(&core).unwrap();
                symlink(&f.cli, &core).unwrap();
            }
            "nonexecutable" => {
                write_pristine(&core, 0o600);
            }
            "valid" => {}
            _ => {}
        }
        if mode == "valid" {
            let identity = inspect_installation(&f.inputs, &f.app).unwrap();
            assert_eq!(identity.version, RELEASE_VERSION);
        } else {
            assert!(inspect_installation(&f.inputs, &f.app).is_err(), "{mode}");
        }
    }
}

#[test]
fn attached_registration_changes_and_swapped_executable_aliases_invalidate_recorded_identity() {
    let f = fixture(false);
    let first = f.home.join("old-pacer");
    let second = f.home.join("other-pacer");
    let alias = f.home.join("bin-pacer");
    write_pristine(&first, 0o755);
    write_pristine(&second, 0o755);
    symlink(&first, &alias).unwrap();
    let text = plist_text(
        f.home.to_str().unwrap(),
        f.pacer_home.to_str().unwrap(),
        "54321",
        alias.to_str().unwrap(),
    );
    std::fs::write(&f.registration, text).unwrap();
    let expected = inspect_installation(&f.inputs, &f.app).unwrap();
    std::fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();
    assert!(verify_installation(&f.inputs, &expected).is_err());
}

#[test]
fn bundle_mismatches_and_missing_bootstrap_registration_refuse_before_native_mutation() {
    for mode in [
        "version",
        "arch",
        "registration",
        "other_app",
        "translocation",
    ] {
        let f = fixture(false);
        match mode {
            "version" => {
                let mut v = base_release(false).as_object().unwrap().clone();
                v.insert("version".into(), json!("2.0.0"));
                std::fs::write(
                    f.app.join("Contents/Resources/pacer-release.json"),
                    Value::Object(v).to_string(),
                )
                .unwrap();
            }
            "arch" => {
                let mut v = base_release(false).as_object().unwrap().clone();
                v.insert(
                    "arch".into(),
                    json!(if host_arch() == "aarch64" {
                        "x86_64"
                    } else {
                        "aarch64"
                    }),
                );
                std::fs::write(
                    f.app.join("Contents/Resources/pacer-release.json"),
                    Value::Object(v).to_string(),
                )
                .unwrap();
            }
            "registration" => std::fs::remove_file(&f.registration).unwrap(),
            "other_app" => {
                let other = fixture(false);
                let text = plist_text(
                    f.home.to_str().unwrap(),
                    f.pacer_home.to_str().unwrap(),
                    "54321",
                    other.cli.to_str().unwrap(),
                );
                std::fs::write(&f.registration, text).unwrap();
            }
            "translocation" => {
                let moved = f.home.join("AppTranslocation/pacer.app");
                std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
                std::fs::rename(&f.app, &moved).unwrap();
            }
            _ => {}
        }
        assert!(inspect_installation(&f.inputs, &f.app).is_err(), "{mode}");
    }
}

#[test]
fn installation_fingerprint_uses_canonical_field_ordering_and_binds_executable_plus_registration() {
    let f = fixture(false);
    let identity = inspect_installation(&f.inputs, &f.app).unwrap();
    let text = std::fs::read_to_string(&f.registration).unwrap();
    let binary = f.cli.to_string_lossy().into_owned();
    let id = identity.id.clone();
    assert_eq!(installation_fingerprint(&identity, &binary, &text), id);
    assert_eq!(
        installation_fingerprint(&identity, &binary, &text),
        installation_fingerprint(&identity, &binary, &text)
    );
    assert_ne!(
        installation_fingerprint(&identity, &format!("{binary}-other"), &text),
        id
    );
    assert_ne!(
        installation_fingerprint(&identity, &binary, &format!("{text}\n")),
        id
    );
}

#[test]
fn shared_adoption_identity_fixture_matches_native_ordered_serialization() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/desktop-update/adoption-identity.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let obj = raw.as_object().unwrap();
    let id = obj.get("identity").unwrap().as_object().unwrap();
    let installation = Installation {
        id: String::new(),
        app_path: PathBuf::from(id.get("appPath").unwrap().as_str().unwrap()),
        bundle_id: id.get("bundleId").unwrap().as_str().unwrap().to_owned(),
        owner_uid: id.get("ownerUid").unwrap().as_u64().unwrap(),
        arch: id.get("arch").unwrap().as_str().unwrap().to_owned(),
        pacer_home: PathBuf::from(id.get("pacerHome").unwrap().as_str().unwrap()),
        port: id.get("port").unwrap().as_u64().unwrap(),
        service_label: id.get("serviceLabel").unwrap().as_str().unwrap().to_owned(),
        ownership: id.get("ownership").unwrap().as_str().unwrap().to_owned(),
        version: String::new(),
    };
    let binary = obj.get("binary").unwrap().as_str().unwrap();
    let registration = obj.get("registrationText").unwrap().as_str().unwrap();
    let expected = obj.get("expected").unwrap().as_str().unwrap();
    assert_eq!(
        installation_fingerprint(&installation, binary, registration),
        expected
    );
}
