//! Transcribed from `test/update-run.test.ts:275-373` and the owner cases in
//! `test/install-owner.test.ts:81-133`.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_foundation::Ctx;
use pacer_update::manager::{
    MANAGED_BY_DESKTOP_MESSAGE, ManagedBy, install_manager, owner_refusal, update_manager,
};
use std::{collections::HashMap, fs, os::unix::fs::symlink, path::Path};

const NPM_LATEST: &str =
    "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@latest";
const NPM_NIGHTLY: &str =
    "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@nightly";
const BREW: &str = "pacer was installed with Homebrew; update with: brew upgrade pacer";
const APP: &str = "this executable belongs to the desktop app; use Settings → Updates in the desktop to update the complete app";

fn ctx(home: &Path, env: HashMap<String, String>) -> Ctx {
    Ctx::with(home.to_path_buf(), home.join(".pacer"), env, 1.0)
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn executable(parent: &Path, relative: &str) -> std::path::PathBuf {
    let path = parent.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "#!/bin/sh\necho 'pacer 0.1.0'\n").unwrap();
    path
}

#[test]
fn npm_installations_report_the_stable_and_nightly_hints() {
    let dir = tempfile::tempdir().unwrap();
    let exec = executable(dir.path(), "bin/pacer");
    let e = env(&[("PACER_INSTALL_METHOD", "npm")]);
    let stable = install_manager(&e, &exec, false).unwrap();
    assert_eq!(stable.by, ManagedBy::Npm);
    assert_eq!(stable.message, NPM_LATEST);
    let nightly = install_manager(&e, &exec, true).unwrap();
    assert_eq!(nightly.message, NPM_NIGHTLY);
}

#[test]
fn homebrew_detection_follows_symlinks_and_honors_configured_prefixes() {
    let dir = tempfile::tempdir().unwrap();

    let cellar = executable(dir.path(), "Cellar/pacer/0.1.0/bin/pacer");
    let link = dir.path().join("bin/pacer");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&cellar, &link).unwrap();
    assert_eq!(
        install_manager(&env(&[]), &link, false).unwrap().message,
        BREW
    );

    let custom = executable(dir.path(), "custom/bin/pacer");
    let link = dir.path().join("other/pacer");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&custom, &link).unwrap();
    let e = env(&[(
        "HOMEBREW_PREFIX",
        custom.parent().unwrap().parent().unwrap().to_str().unwrap(),
    )]);
    assert_eq!(install_manager(&e, &link, false).unwrap().message, BREW);

    // A configured cellar with a trailing slash is realpath'd before the prefix check.
    let prefix = custom.parent().unwrap().parent().unwrap();
    let e = env(&[("HOMEBREW_CELLAR", &format!("{}/", prefix.display()))]);
    assert_eq!(install_manager(&e, &link, false).unwrap().message, BREW);
}

#[test]
fn a_sibling_of_a_homebrew_prefix_is_not_managed() {
    let dir = tempfile::tempdir().unwrap();
    let exec = executable(dir.path(), "bin/pacer");
    let sibling = dir.path().join("bin-other");
    let e = env(&[("HOMEBREW_PREFIX", sibling.to_str().unwrap())]);
    assert!(install_manager(&e, &exec, false).is_none());
}

#[test]
fn app_bundled_macos_and_resources_executables_are_managed_direct_and_symlinked() {
    let dir = tempfile::tempdir().unwrap();
    for location in ["MacOS", "Resources"] {
        let binary = executable(dir.path(), &format!("pacer.app/Contents/{location}/pacer"));
        let found = install_manager(&env(&[]), &binary, false).unwrap();
        assert_eq!(found.by, ManagedBy::Desktop);
        assert_eq!(found.message, APP);

        let link = dir.path().join(format!("bin-{location}/pacer"));
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&binary, &link).unwrap();
        assert_eq!(
            install_manager(&env(&[]), &link, false).unwrap().message,
            APP
        );
    }
}

#[test]
fn npm_and_homebrew_hints_take_precedence_over_the_app_bundle() {
    let dir = tempfile::tempdir().unwrap();
    let binary = executable(dir.path(), "pacer.app/Contents/MacOS/pacer");
    let prefix = dir.path().join("pacer.app");
    let npm = env(&[
        ("HOMEBREW_PREFIX", prefix.to_str().unwrap()),
        ("PACER_INSTALL_METHOD", "npm"),
    ]);
    assert_eq!(
        install_manager(&npm, &binary, false).unwrap().message,
        NPM_LATEST
    );
    let brew = env(&[("HOMEBREW_PREFIX", prefix.to_str().unwrap())]);
    assert_eq!(
        install_manager(&brew, &binary, false).unwrap().message,
        BREW
    );
}

fn write_owner(home: &Path, executable: &Path) {
    fs::create_dir_all(home.join(".pacer")).unwrap();
    let record = serde_json::json!({
        "schema": 1,
        "owner": "desktop",
        "executable": executable.to_str().unwrap(),
        "at": 1,
    });
    fs::write(home.join(".pacer/owner.json"), record.to_string()).unwrap();
}

#[test]
fn desktop_owner_refuses_a_foreign_cli_and_admits_its_own_executable() {
    let dir = tempfile::tempdir().unwrap();
    let recorded = executable(dir.path(), "pacer.app/Contents/Resources/pacer");
    let foreign = executable(dir.path(), "usr/local/bin/pacer");
    write_owner(dir.path(), &recorded);

    let stranger = ctx(dir.path(), env(&[("PACER_BIN", foreign.to_str().unwrap())]));
    assert!(owner_refusal(&stranger, Path::new("/usr/local/bin")));
    let manager = update_manager(&stranger, &foreign, Path::new("/usr/local/bin"), false).unwrap();
    assert_eq!(manager.by, ManagedBy::Desktop);
    assert_eq!(manager.message, MANAGED_BY_DESKTOP_MESSAGE);

    let own = ctx(
        dir.path(),
        env(&[("PACER_BIN", recorded.to_str().unwrap())]),
    );
    assert!(!owner_refusal(&own, foreign.parent().unwrap()));
    assert!(update_manager(&own, &foreign, foreign.parent().unwrap(), false).is_none());
}

#[test]
fn desktop_owner_admits_the_core_running_beside_the_front_door() {
    let dir = tempfile::tempdir().unwrap();
    let recorded = executable(dir.path(), "pacer.app/Contents/Resources/pacer");
    let other = executable(dir.path(), "elsewhere/pacer");
    write_owner(dir.path(), &recorded);

    let core = ctx(dir.path(), env(&[]));
    assert!(!owner_refusal(&core, recorded.parent().unwrap()));
    assert!(owner_refusal(&core, other.parent().unwrap()));
}
