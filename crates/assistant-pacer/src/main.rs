//! Native plugin binary `pacer-assistant-pacer`.

use pacer_assistant_pacer::plugin;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    plugin().serve_stdio().await
}
