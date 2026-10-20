fn main() {
    println!("cargo:rerun-if-env-changed=PACER_BUILD_VERSION");
    if let Ok(version) = std::env::var("PACER_BUILD_VERSION") {
        println!("cargo:rustc-env=PACER_BUILD_VERSION={version}");
    }
}
