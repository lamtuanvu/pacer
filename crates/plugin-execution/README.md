# Native plugin execution owners

This is an unpublished shadow library. It owns direct and remote runs, run
directories, Git inspection and verified bundle transfer, worktree receipts and the
fixed SSH transfer over the pinned resources of layer-3 `pacer-plugin-capabilities`.
It has no Orca attempt/session code, registry, RPC admission or client operation.
The TypeScript plugin host is authoritative (RUST-7); nothing here is served
until cutover.

Layer-5 `pacer-plugin-runtime` re-exports these modules and root types, so existing
runtime and host paths name the same items. The modules moved from runtime with
their bytes and `src/`-relative paths unchanged, including the run wrapper script.

Tests live at the runtime and host facades; this crate has no tests or
dev-dependencies. Native live surfaces are UNVERIFIED under the recorded M2
unserved-library exception until first cutover.
