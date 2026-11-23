//! Native plugin binary `pacer-assistant-pacer`.

use pacer_assistant_pacer::plugin;

fn release_version() -> &'static str {
    option_env!("PACER_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    if let Some(arg) = args.next() {
        if matches!(arg.as_str(), "--version" | "version") && args.next().is_none() {
            println!("pacer {}", release_version());
            return Ok(());
        }
        eprintln!("usage: pacer-assistant-pacer [--version]");
        std::process::exit(2);
    }
    plugin().serve_stdio().await
}
