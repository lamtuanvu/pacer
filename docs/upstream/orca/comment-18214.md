<!-- Comment for https://github.com/stablyai/orca/issues/18214 -->
<!-- Status: draft for review. Not posted. -->

+1. Same constraint from a different plugin: anything a panel wants to run has to be typed into an existing terminal in the focused worktree. My plugin ends up keeping a helper process running in a terminal of every worktree just so panel buttons have somewhere to send commands.

If a general `exec` is too broad for the sandbox model, a narrower alternative would also solve my case: let a plugin run **its own declared command** (for example a binary named in the manifest), with the result returned to the worker rather than the panel. Either way, the key is not depending on a terminal in the active worktree.
