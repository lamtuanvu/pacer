use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for input in [
        "app/src",
        "app/index.html",
        "app/build.ts",
        "app/xterm-csp.ts",
        "app/tokens-gen.ts",
        "app/tsconfig.json",
        "package.json",
        "bun.lock",
        "node_modules/@xterm/xterm/css/xterm.css",
    ] {
        let path = root.join(input);
        if !path.exists() {
            panic!(
                "web build input is absent ({}); run bun install --frozen-lockfile",
                path.display()
            );
        }
        println!("cargo:rerun-if-changed={}", path.display());
    }
    // Cargo watches the web inputs; Bun rebuilds their content-hashed output.
    let output = Command::new("bun")
        .args(["-e", "import { buildApp } from './app/build.ts'; process.stdout.write(JSON.stringify(await buildApp()));"])
        .current_dir(&root)
        .output()
        .unwrap_or_else(|error| panic!("cannot build embedded web app (bun): {error}; run bun install --frozen-lockfile"));
    if !output.status.success() {
        panic!(
            "cannot build embedded web app: {}; run bun run app:build",
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
