use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = root.join("src/app/assets.generated.ts");
    println!("cargo:rerun-if-changed={}", source.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("package.json").display()
    );
    let input = fs::read_to_string(&source).unwrap_or_else(|error| {
        panic!(
            "embedded web app is absent ({}): {error}; run bun run app:build",
            source.display()
        )
    });
    let version = input
        .split_once("export const APP_VERSION = ")
        .and_then(|(_, tail)| tail.split_once(';'))
        .and_then(|(value, _)| serde_json::from_str::<String>(value).ok())
        .unwrap_or_else(|| panic!("embedded web app has no valid version; run bun run app:build"));
    let package_text = fs::read_to_string(root.join("package.json"))
        .unwrap_or_else(|error| panic!("package.json is required: {error}"));
    let package: serde_json::Value = serde_json::from_str(&package_text)
        .unwrap_or_else(|error| panic!("package.json must be JSON: {error}"));
    assert_eq!(
        package["version"].as_str(),
        Some(version.as_str()),
        "embedded web app version is stale; run bun run app:build"
    );
    let json = input
        .split_once("export const APP_FILES: { path: string; type: string; text: string }[] = ")
        .and_then(|(_, tail)| tail.strip_suffix(";\n"))
        .unwrap_or_else(|| panic!("embedded web app has no asset list; run bun run app:build"));
    let files: serde_json::Value = serde_json::from_str(json).unwrap_or_else(|error| {
        panic!("embedded web app is malformed: {error}; run bun run app:build")
    });
    assert!(
        files
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file["path"] == "index.html")),
        "embedded web app has no index.html; run bun run app:build"
    );
    let out = env::var_os("OUT_DIR").unwrap_or_else(|| panic!("OUT_DIR is required"));
    fs::write(PathBuf::from(out).join("app-assets.json"), json)
        .unwrap_or_else(|error| panic!("cannot write embedded web assets: {error}"));
}
