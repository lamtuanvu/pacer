fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        Some("--pacer-identity") => println!("{}", serde_json::json!({
            "schema": 1, "role": "update-helper", "bundleId": "dev.pacer.desktop",
            "version": env!("CARGO_PKG_VERSION"), "arch": std::env::consts::ARCH,
        })),
        _ => { eprintln!("Native update transactions are not available in this build"); std::process::exit(2); }
    }
}
