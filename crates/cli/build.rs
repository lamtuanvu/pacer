//! The front door reports the same version as the core: an explicit `PACER_BUILD_VERSION`
//! (release and local builds), else the workspace `package.json` version.
fn main() {
    println!("cargo:rerun-if-env-changed=PACER_COMPONENT_BUILD_ID");
    let build_id = std::env::var("PACER_COMPONENT_BUILD_ID").unwrap_or_else(|_| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("local-{}-{now}", std::process::id())
    });
    println!("cargo:rustc-env=PACER_COMPONENT_BUILD_ID={build_id}");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    println!(
        "cargo:rustc-env=PACER_COMPONENT_TARGET_OS={}",
        if os == "macos" { "darwin" } else { &os }
    );
    println!(
        "cargo:rustc-env=PACER_COMPONENT_TARGET_ARCH={}",
        if arch == "aarch64" {
            "arm64"
        } else if arch == "x86_64" {
            "x64"
        } else {
            &arch
        }
    );
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
