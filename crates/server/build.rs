use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    println!("cargo:rerun-if-env-changed=PACER_BUILD_VERSION");
    let package = root.join("package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let package_version = fs::read_to_string(&package)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("version")?.as_str().map(str::to_owned))
        // Fixture builds may have no readable package.json; the parity tests catch a wrong version.
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_default());
    // The TypeScript core reports package.json's version in hello; so does the Rust proxy.
    println!("cargo:rustc-env=PACER_PACKAGE_VERSION={package_version}");
    let version = std::env::var("PACER_BUILD_VERSION").unwrap_or(package_version);
    println!("cargo:rustc-env=PACER_BUILD_VERSION={version}");
    let manifest = root.join("app/assets.generated.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = fs::read_to_string(&manifest)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", manifest.display()));
    let bundle: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("app/assets.generated.json is malformed: {error}"));
    let files = bundle.get("files").cloned().unwrap_or_else(|| panic!("app/assets.generated.json has no files"));
    assert!(
        files
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file["path"] == "index.html")),
        "web build has no index.html"
    );
    let out = env::var_os("OUT_DIR").unwrap_or_else(|| panic!("OUT_DIR is required"));
    let bytes = serde_json::to_vec(&files).unwrap_or_else(|error| panic!("cannot encode web assets: {error}"));
    fs::write(PathBuf::from(out).join("app-assets.json"), bytes)
        .unwrap_or_else(|error| panic!("cannot write embedded web assets: {error}"));
}
