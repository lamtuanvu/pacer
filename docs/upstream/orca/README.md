# Orca upstream drafts (for review, nothing posted)

Verified against Orca 1.4.224. Each file says where it would go. Posting is the user's decision; post with the web UI, or `gh issue comment` / `gh issue create -R stablyai/orca` after approval.

| File | Where | Ask |
|---|---|---|
| `comment-25129.md` | comment on stablyai/orca#25129 | Panel -> worker messaging; pacer's console-per-worktree workaround as evidence; CLI -> plugin channel folded in |
| `comment-26951.md` | comment on stablyai/orca#26951 (links #15638) | Live data in panels; the rewrite-the-HTML workaround and its flashing |
| `comment-18214.md` | comment on stablyai/orca#18214 | Exec / declared command, not tied to the active worktree's terminal |
| `issue-plugin-terminals.md` | new feature request | `terminal.create` for plugins, and `sendText` to plugin-owned terminals in any worktree |
| `issue-panel-forms.md` | new feature request | Forms silently never submit in panels: add `allow-forms` or document it |

Supersedes the single combined proposal in `../orca-plugin-channel.md`, kept for history.
Checked for private details: no local paths, account names or emails.
