<!-- Comment for https://github.com/stablyai/orca/issues/26951 (also see #15638) -->
<!-- Status: draft for review. Not posted. -->

+1 with a data point on the workaround people end up building. Related: #15638.

My plugin (pacer, a usage-budget and delegation tool) shows live subscription usage in a panel. With no worker -> panel channel, the only way I found to update the panel is for the worker to **rewrite the panel's HTML file on disk**. That works only for a plugin loaded from a development path (an installed copy has a content hash), and only because the host re-reads the entry file when the panel opens.

In practice, on Orca 1.4.224:

- The host hot-reloads a development-path panel whenever its entry file changes. My first version rewrote the file on a 10-second heartbeat, and the panel visibly flashed every 10 seconds. I now rewrite only when user-visible content changes, and compute ages ("updated 2 min ago") client-side.
- Liveness has to be baked into the HTML at render time. The panel then has to decide, without fresh data, whether an action is still safe. I keep a 30-second freshness rule and re-check `workspace.readContext()` at click time.
- None of this works for an installed plugin.

A status bar item would cover the "glanceable number" part (for me, "Claude 34% used, on pace"). A worker -> panel message would cover the rest and let the panel stop being a file the worker rewrites.
