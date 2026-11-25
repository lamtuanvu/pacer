//! Transcribed from `test/update-run.test.ts:275-373` and the owner-exemption cases
//! in `test/install-owner.test.ts`.
use pacer_foundation::Ctx;
use pacer_update::manager::{
    MANAGED_BY_DESKTOP_MESSAGE, ManagedBy, install_manager, owner_refusal, update_manager,
};
use serde_json::json;
use std::{collections::HashMap, fs, path::Path};

fn ctx(home: &Path, env: &[(&str, &str)]) -> Ctx {
    Ctx::with(
        home.to_path_buf(),
        home.join(".pacer"),
        env.iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect::<HashMap<_, _>>(),
        1_000_000.5,
    )
}

fn script(version: &str) -> String {
    format!("#!/bin/sh\necho \"pacer {version}\"\n")
}

fn write_executable(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, script("0.1.0")).unwrap();
}

fn write_owner(context: &Ctx, owner: &str, executable: &Path) {
    fs::create_dir_all(&context.pacer_home).unwrap();
    fs::write(
        context.pacer_home.join("owner.json"),
        json!({"schema": 1, "owner": owner, "executable": executable.to_string_lossy(), "at": 1})
            .to_string(),
    )
    .unwrap();
}

const NPM_MESSAGE: &str =
    "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@latest";
const BREW_MESSAGE: &str = "pacer was installed with Homebrew; update with: brew upgrade pacer";
const APP_MESSAGE: &str =
    "this executable belongs to the desktop app; use Settings → Updates in the desktop to update the complete app";

#[test]
fn npm_installation_reports_its_hint_and_nightly_tag() {
    let env = HashMap::from([("PACER_INSTALL_METHOD".to_owned(), "npm".to_owned())]);
    let stable = install_manager(&env, Path::new("/usr/local/bin/pacer"), false).unwrap();
    assert_eq!(stable.by, ManagedBy::Npm);
    assert_eq!(stable.message, NPM_MESSAGE);
    let nightly = install_manager(&env, Path::new("/usr/local/bin/pacer"), true).unwrap();
    assert!(nightly.message.ends_with("@nightly"), "{}", nightly.message);
}

#[test]
fn homebrew_detection_follows_executable_symlinks_and_honors_configured_prefixes() {
    for mode in ["cellar", "prefix", "custom-cellar"] {
        let root = tempfile::tempdir().unwrap();
        let relative = if mode == "cellar" {
            "Cellar/pacer/0.1.0/bin/pacer"
        } else {
            "custom/bin/pacer"
        };
        let real = root.path().join(relative);
        write_executable(&real);
        let alias_root = tempfile::tempdir().unwrap();
        let exec = alias_root.path().join("pacer");
        std::os::unix::fs::symlink(&real, &exec).unwrap();

        let mut env = HashMap::new();
        if mode == "prefix" {
            env.insert("HOMEBREW_PREFIX".to_owned(), root.path().join("custom").to_string_lossy().into_owned());
        }
        if mode == "custom-cellar" {
            env.insert(
                "HOMEBREW_CELLAR".to_owned(),
                format!("{}/", root.path().join("custom").display()),
            );
        }
        let manager = install_manager(&env, &exec, false).unwrap();
        assert_eq!(manager.by, ManagedBy::Homebrew, "{mode}");
        assert_eq!(manager.message, BREW_MESSAGE, "{mode}");
    }
}

#[test]
fn app_bundled_executables_report_the_desktop_hint() {
    for location in ["MacOS", "Resources"] {
        for linked in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let binary = home.path().join(format!("pacer.app/Contents/{location}/pacer"));
            let link = home.path().join(".local/bin/pacer");
            write_executable(&binary);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&binary, &link).unwrap();
            let exec = if linked { &link } else { &binary };
            let manager = install_manager(&HashMap::new(), exec, false).unwrap();
            assert_eq!(manager.by, ManagedBy::Desktop, "{location}/{linked}");
            assert_eq!(manager.message, APP_MESSAGE, "{location}/{linked}");
        }
    }
}

#[test]
fn npm_and_homebrew_take_precedence_over_the_app_bundle_hint() {
    let prefix = tempfile::tempdir().unwrap();
    let binary = prefix.path().join("pacer.app/Contents/MacOS/pacer");
    write_executable(&binary);
    for npm in [true, false] {
        let mut env = HashMap::from([(
            "HOMEBREW_PREFIX".to_owned(),
            prefix.path().to_string_lossy().into_owned(),
        )]);
        if npm {
            env.insert("PACER_INSTALL_METHOD".to_owned(), "npm".to_owned());
        }
        let manager = install_manager(&env, &binary, false).unwrap();
        if npm {
            assert_eq!(manager.by, ManagedBy::Npm);
            assert_eq!(manager.message, NPM_MESSAGE);
        } else {
            assert_eq!(manager.by, ManagedBy::Homebrew);
            assert_eq!(manager.message, BREW_MESSAGE);
        }
    }
}

#[test]
fn a_sibling_of_a_homebrew_prefix_is_not_managed() {
    let root = tempfile::tempdir().unwrap();
    let exec = root.path().join("pacer");
    write_executable(&exec);
    let env = HashMap::from([(
        "HOMEBREW_PREFIX".to_owned(),
        format!("{}-other", exec.parent().unwrap().display()),
    )]);
    assert!(install_manager(&env, &exec, false).is_none());
}

#[test]
fn owner_json_desktop_refuses_a_foreign_cli() {
    let home = tempfile::tempdir().unwrap();
    let recorded = home.path().join("pacer.app/Contents/Resources/pacer");
    let context = ctx(home.path(), &[("PACER_BIN", "/usr/local/bin/pacer")]);

    assert!(!owner_refusal(&context, Path::new("/usr/local/bin")));
    write_owner(&context, "cli", &recorded);
    assert!(!owner_refusal(&context, Path::new("/usr/local/bin")));
    write_owner(&context, "desktop", &recorded);
    assert!(owner_refusal(&context, Path::new("/usr/local/bin")));
}

#[test]
fn bundled_cli_exemption_uses_pacer_bin_or_the_front_door_directory() {
    let home = tempfile::tempdir().unwrap();
    let bundled = home.path().join("pacer.app/Contents/Resources/pacer");
    write_executable(&bundled);
    let context = ctx(
        home.path(),
        &[("PACER_BIN", bundled.to_str().unwrap())],
    );
    write_owner(&context, "desktop", &bundled);
    assert!(!owner_refusal(&context, Path::new("/unrelated")));

    let foreign = home.path().join("other-pacer");
    write_executable(&foreign);
    let other = ctx(home.path(), &[("PACER_BIN", foreign.to_str().unwrap())]);
    assert!(owner_refusal(&other, Path::new("/unrelated")));

    // The core running beside the recorded front door is exempt even without PACER_BIN.
    let beside = home.path().join("pacer.app/Contents/Resources/pacer");
    let no_bin = ctx(home.path(), &[]);
    write_owner(&no_bin, "desktop", &beside);
    assert!(!owner_refusal(&no_bin, beside.parent().unwrap()));
    write_owner(&no_bin, "desktop", &home.path().join("elsewhere/pacer"));
    assert!(owner_refusal(&no_bin, beside.parent().unwrap()));
}

#[test]
fn owner_exemption_follows_a_symlinked_executable() {
    let home = tempfile::tempdir().unwrap();
    let bundled = home.path().join("pacer.app/Contents/Resources/pacer");
    write_executable(&bundled);
    let link = home.path().join(".local/bin/pacer");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&bundled, &link).unwrap();
    let context = ctx(home.path(), &[("PACER_BIN", link.to_str().unwrap())]);
    write_owner(&context, "desktop", &bundled);
    assert!(!owner_refusal(&context, Path::new("/unrelated")));
}

#[test]
fn update_manager_prefers_a_desktop_owner_over_the_install_method() {
    let home = tempfile::tempdir().unwrap();
    let recorded = home.path().join("pacer.app/Contents/Resources/pacer");
    let exec = home.path().join("pacer");
    write_executable(&exec);
    let context = ctx(
        home.path(),
        &[("PACER_INSTALL_METHOD", "npm"), ("PACER_BIN", "/usr/local/bin/pacer")],
    );
    write_owner(&context, "desktop", &recorded);
    let manager = update_manager(&context, &exec, Path::new("/usr/local/bin"), false).unwrap();
    assert_eq!(manager.by, ManagedBy::Desktop);
    assert_eq!(manager.message, MANAGED_BY_DESKTOP_MESSAGE);
}
