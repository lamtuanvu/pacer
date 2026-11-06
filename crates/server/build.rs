use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    println!("cargo:rerun-if-env-changed=PACER_BUILD_VERSION");
    let package = root.join("package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let version = std::env::var("PACER_BUILD_VERSION").ok().or_else(|| {
        let text = fs::read_to_string(&package).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        value.get("version")?.as_str().map(str::to_owned)
    });
    if let Some(version) = version {
        println!("cargo:rustc-env=PACER_BUILD_VERSION={version}");
    }
    let assets = root.join("src/app/assets.generated.ts");
    println!("cargo:rerun-if-changed={}", assets.display());
    // Import the same checked-in bundle used by the TypeScript server.
    let output = Command::new("bun")
        .args(["-e", "import { APP_FILES } from './src/app/assets.generated.ts'; process.stdout.write(JSON.stringify(APP_FILES));"])
        .current_dir(&root)
        .output()
        .unwrap_or_else(|error| panic!("cannot read embedded web assets (bun): {error}"));
    if !output.status.success() {
        panic!(
            "cannot read embedded web assets: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let files: serde_json::Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("web build returned malformed assets: {error}"));
    assert!(
        files
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file["path"] == "index.html")),
        "web build has no index.html"
    );
    let out = env::var_os("OUT_DIR").unwrap_or_else(|| panic!("OUT_DIR is required"));
    fs::write(PathBuf::from(out).join("app-assets.json"), output.stdout)
        .unwrap_or_else(|error| panic!("cannot write embedded web assets: {error}"));
}
