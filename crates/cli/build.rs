//! The front door reports the same version as the core: an explicit `PACER_BUILD_VERSION`
//! (release and local builds), else the workspace `package.json` version.
fn main() {
    println!("cargo:rerun-if-env-changed=PACER_BUILD_VERSION");
    let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let version = std::env::var("PACER_BUILD_VERSION").ok().or_else(|| {
        let text = std::fs::read_to_string(&package).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        value.get("version")?.as_str().map(str::to_owned)
    });
    if let Some(version) = version {
        println!("cargo:rustc-env=PACER_BUILD_VERSION={version}");
    }
}
