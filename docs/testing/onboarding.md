# Fresh-account onboarding test (Orca plugin)

Goal: prove that a person with Orca and nothing else gets a working pacer by installing the plugin, plus one click to connect their agents. Run it on a **new macOS user account**, so no existing `~/.pacer`, `~/.local/bin/pacer`, login service or agent config can hide a bug.

Applies to pacer 0.1.16 and later. Time: about 20 minutes. Record the result of every step marked **Check**.

## 0. Prepare (your normal account)

1. Create the test account: System Settings → Users & Groups → Add User. Standard account, any name (below: `pacertest`).
2. Pick the source:
   - **Unreleased build** (testing a branch before its release): from a pacer checkout, build and stage a copy the test account can read:
     ```sh
     bun run release:host && bun run plugin:build
     sh scripts/onboarding-test/stage.sh
     ```
     It prints the release folder (`file:///Users/Shared/pacer-onboarding-test/release`) and the plugin folder.
   - **Published release** (on GitHub Releases, with its `orca-plugin-v<version>` tag): nothing to stage. Copy [`scripts/onboarding-test/check.sh`](../../scripts/onboarding-test/check.sh) to `/Users/Shared/pacer-onboarding-test/` for the checks.

## 1. Start clean (test account)

Log in as `pacertest` (fast user switching is fine). Install Orca from its website and sign in as you normally would. Optional, to test agent connection: install one or more agent CLIs (Claude Code, Codex, Cursor CLI, OpenCode) and put them on `PATH`.

**Check** that nothing pacer exists yet:

```sh
ls ~/.local/bin/pacer ~/.pacer ~/Library/LaunchAgents/com.pacer.serve.plist 2>&1
```

Expected: three "No such file or directory" lines.

## 2. Install the plugin

Orca → Settings → search "plugin" → Plugins → turn on **Plugin system** if needed.

- **Local source (unreleased build):** Development → add the plugin folder `/Users/Shared/pacer-onboarding-test/plugin`.
- **GitHub source (published release):** Manage sources → add `https://github.com/lamtuanvu/pacer.git`, ref `main`, then install **pacer** (`lamtuanvu.pacer`).

Then **Review & enable**. **Check:** the review lists exactly six permissions (focused worktree info, type into a visible terminal, notifications, worktree/agent-status events, own storage, own settings) plus Orca's note that the worker runs as a normal process. Note anything else.

**Local source only:** before enabling, set the plugin's **releaseBase** setting to `file:///Users/Shared/pacer-onboarding-test/release` (Plugins → pacer → ⋯ → Settings). Without it the plugin tries GitHub and should show "pacer isn't published yet…"; seeing that message first is a valid extra check.

## 3. Watch it install pacer (no clicks)

Open the pacer panel in Orca's right sidebar (gauge icon).

**Check**, within about a minute:

- The panel shows a checklist: **Install pacer** → **Start pacer** → **Connect your agents**, the first two moving from spinner to ✓.
- Then it turns **Live** with a budget card. The planner and executor rows depend on which CLIs are installed; "No budget reported" is fine on a fresh machine.
- In Terminal: `sh /Users/Shared/pacer-onboarding-test/check.sh` shows PASS for binary, strategy, login service, service running, link healthy and both checklist steps, and **INFO "agent not connected"** for every agent.
- Consent: `ls ~/.claude/skills ~/.codex/skills 2>&1` shows no `pacer` folder. If any agent file appeared before step 4, that's a **FAIL** (the plugin must not touch agent config without the click).

Timings to note: seconds from enabling to Install ✓, to Start ✓, to Live.

## 4. Connect agents (one click)

Only if at least one agent CLI is installed. **Check** the panel first: it lists the detected CLIs and, for each, the files it will change and how to undo it.

Click **Connect my agents**. If the worktree has no terminal, the panel says it's opening one and a terminal titled **pacer setup** appears.

**Check:**

- The terminal runs `pacer setup --yes` and prints one line per agent (`connected`) with an `Undo:` line.
- The panel shows **Connected: …** with the same agents and the button disappears.
- `check.sh` now shows PASS "agent connected" for each, and no FAIL about MCP.

## 5. Keeps itself working

1. **Service restart (self-heal):** `launchctl bootout gui/$(id -u)/com.pacer.serve`. **Check:** the panel shows "Restarting pacer…" or the checklist, and is Live again within about 75 s without any click; `check.sh` passes again.
2. **Console:** close any `pacer console` terminal. **Check:** after you focus that worktree, a pacer console terminal reopens on its own within about 10 s.
3. **Panel buttons:** click **Delegate a task** only if you have an executor CLI signed in; otherwise just confirm the buttons render and the action bar isn't disabled with an error.

## 6. Clean up

In the test account:

```sh
for a in claude-code codex cursor opencode; do ~/.local/bin/pacer uninstall $a 2>/dev/null; done
~/.local/bin/pacer service uninstall
rm -rf ~/.pacer ~/.local/bin/pacer ~/.local/bin/pacer.bak
```

Orca → Plugins → pacer → ⋯ → Uninstall. Then delete the test account in System Settings if you don't need it, and remove `/Users/Shared/pacer-onboarding-test` from your own account.

## Report template

```
Source: local / GitHub        Orca version:        pacer version:
Agent CLIs installed: 
Step 1 clean:        PASS/FAIL
Step 2 permissions:  PASS/FAIL  (notes)
Step 3 auto-install: PASS/FAIL  timings: install __s, start __s, live __s
Step 3 consent:      PASS/FAIL
Step 4 connect:      PASS/FAIL/N/A
Step 5 self-heal:    PASS/FAIL  console reopen: PASS/FAIL
check.sh output (final):
Screenshots of anything unexpected:
```
