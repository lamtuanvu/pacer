//! Table of bundled plugins: manifest text and entry function (M3 phase C).
use pacer_plugin::Plugin;

#[derive(Clone, Copy)]
pub struct Bundled {
    pub id: &'static str,
    /// The manifest JSON, byte-equal to the TypeScript runtime manifest (test/plugin-parity/manifests.test.ts).
    pub manifest: &'static str,
    /// `None`: still TypeScript; `pacer plugin run <id>` execs `pacer-core plugin run <id>`.
    pub run: Option<fn() -> Plugin>,
}

/// Same order as `plugins/bundled.ts:16-38` (without the sibling-executable row).
/// Kept single-line (`rustfmt::skip`) so `test/plugin-parity/manifests.test.ts`
/// can parse the ids with `/Bundled \{ id: "([^"]+)"/` as the plan requires.
#[rustfmt::skip]
pub const TABLE: &[Bundled] = &[
    Bundled { id: "pacer-planners", manifest: include_str!("../manifests/pacer-planners.json"), run: None },
    Bundled { id: "pacer-endpoints", manifest: include_str!("../manifests/pacer-endpoints.json"), run: None },
    Bundled { id: "pacer-notify", manifest: pacer_bundled_notify::MANIFEST, run: Some(pacer_bundled_notify::plugin) },
    Bundled { id: "pacer-classify", manifest: include_str!("../manifests/pacer-classify.json"), run: None },
    Bundled { id: "pacer-usage", manifest: include_str!("../manifests/pacer-usage.json"), run: None },
    Bundled { id: "pacer-agent-session", manifest: pacer_bundled_agent_session::MANIFEST, run: Some(pacer_bundled_agent_session::plugin) },
    Bundled { id: "pacer-assistant", manifest: include_str!("../manifests/pacer-assistant.json"), run: None },
    Bundled { id: "assistant-executor", manifest: include_str!("../manifests/assistant-executor.json"), run: None },
    Bundled { id: "pacer-ssh", manifest: include_str!("../manifests/pacer-ssh.json"), run: None },
    Bundled { id: "pacer-remote-caller", manifest: pacer_bundled_remote_caller::MANIFEST, run: Some(pacer_bundled_remote_caller::plugin) },
    Bundled { id: "pacer-exec-direct", manifest: include_str!("../manifests/pacer-exec-direct.json"), run: None },
    Bundled { id: "pacer-exec-orca", manifest: include_str!("../manifests/pacer-exec-orca.json"), run: None },
];

pub fn find(id: &str) -> Option<&'static Bundled> {
    TABLE.iter().find(|b| b.id == id)
}

pub fn native(id: &str) -> Option<fn() -> Plugin> {
    find(id).and_then(|b| b.run)
}

/// (id, manifest JSON) for every bundled row, in table order.
pub fn manifests() -> impl Iterator<Item = (&'static str, &'static str)> {
    TABLE.iter().map(|b| (b.id, b.manifest))
}

/// Serve a native bundled plugin on this process's stdio until stdin closes.
/// `None` when `id` is unknown or still TypeScript. Builds a current-thread tokio runtime.
pub fn serve_stdio(id: &str) -> Option<std::io::Result<()>> {
    let run = native(id)?;
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(error) => return Some(Err(error)),
    };
    Some(runtime.block_on(run().serve_stdio()))
}
