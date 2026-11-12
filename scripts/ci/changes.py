"""Select CI work from complete git diffs, without third-party dependencies."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

KEYS = ("bun", "rust", "e2e", "ui", "codeql")
CI_TESTS = ("test/ci-selection.test.ts", "test/ci-service-survival.test.ts",
            "test/release-automation.test.ts", "test/release-workflow.test.ts",
            "test/desktop-release-workflow.test.ts")


def select(paths):
    result = dict.fromkeys(KEYS, False)
    for path in paths:
        # These generated documents have freshness tests, unlike ordinary prose.
        if re.fullmatch(r"docs/(?:plugin-)?protocol(?:-v\d+)?\.(?:md|json)", path):
            result["bun"] = True
        elif path.endswith(".md") and (path.startswith(("docs/", ".project/", ".agents/skills/")) or path in ("app/README.md", "desktop/README.md")):
            continue
        elif path.startswith("app/"):
            for key in ("bun", "ui", "codeql", "e2e"):
                result[key] = True
        elif path.startswith(("crates/", "plugins-rs/", "xtask/", ".cargo/")) or path in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
            result["bun"] = result["rust"] = result["e2e"] = True
        elif path.startswith("src/"):
            result["bun"] = result["codeql"] = True
            # The Rust front door's integration tests exercise the TS core.
            if path.startswith(("src/dashboard/", "src/render/", "src/view-model/")):
                result["ui"] = True
            elif path.startswith("src/app/"):
                result["ui"] = result["e2e"] = True
            else:
                result["rust"] = result["e2e"] = True
        elif path.startswith(("test/", "conformance/")):
            result["bun"] = result["codeql"] = True
            if path.startswith(("test/fixtures/", "conformance/")) or path in ("test/install-signin-delegation.test.ts", "test/helpers.ts", "test/setup.ts"):
                result["e2e"] = True
            if path.startswith("conformance/"):
                result["rust"] = True
        elif path.startswith(("plugins/", "packages/")):
            result["bun"] = result["rust"] = result["codeql"] = result["e2e"] = True
        elif path.startswith("desktop/"):
            # Native presentation and bundle parity also have Bun tests. Desktop
            # terminal-bridge tests run in the Rust job (cargo test --bin pacer).
            result["bun"] = result["ui"] = result["codeql"] = result["rust"] = True
        else:
            # Shared configuration, workflows, scripts and unknown new areas:
            # err on the side of coverage until their dependencies are mapped.
            return dict.fromkeys(KEYS, True)
    return result


SOURCE_TESTS = {
    # These retired leaf modules have no non-test importers; include every test importer.
    "src/console/cli.ts": ("test/autoconsole-worker.test.ts", "test/console-cli.test.ts"),
    "src/console/console.ts": ("test/api-cmd.test.ts", "test/console-settings.test.ts"),
    "src/usage/cache.ts": ("test/cache.test.ts", "test/plugins-usage-readers.test.ts"),
    # metrics -> bench -> plan4 CLI; direct and transitive bench coverage.
    "src/classify/metrics.ts": ("test/bench-metrics.test.ts", "test/bench.test.ts"),
    # Additional leaf modules with focused test coverage
    "src/app/plan.ts": ("test/app-plan.test.ts",),
    "src/app/session.ts": ("test/app-session-bundle.test.ts",),
    "src/plugins/process.ts": ("test/plugins-process.test.ts", "test/plugins-executor-effect.test.ts"),
    "src/plugins/lines.ts": ("test/plugins-lines.test.ts",),
    "src/update/manifest.ts": ("test/update-manifest.test.ts",),
    "src/update/check.ts": ("test/update-check.test.ts",),
    "src/console/autoconsole.ts": ("test/autoconsole-worker.test.ts",),
    "src/plugins/http-broker.ts": ("test/plugins-http-broker.test.ts",),
    "src/plugins/ssh-provider.ts": ("test/plugins-ssh-provider.test.ts",),
    "src/plugins/capability.ts": ("test/plugins-capability-write.test.ts",),
    "src/plugins/ui-schema.ts": ("test/plugins-ui-schema.test.ts",),
    "src/plugins/planner.ts": ("test/plugins-planner-protocol.test.ts", "test/plugins-planner-mode.test.ts"),
    "src/plugins/executor.ts": ("test/plugins-executor-detached-launch.test.ts", "test/plugins-executor-production-current.test.ts"),
    "src/plugins/policy.ts": ("test/plugins-policy-review-conflict.test.ts",),
    "src/plugins/write.ts": ("test/plugins-write-wire.test.ts", "test/plugins-write-registry.test.ts"),
    "src/plugins/bundle.ts": ("test/plugins-bundle-stage.test.ts", "test/plugins-bundled-launch.test.ts"),
    "src/plugins/cli.ts": ("test/plugins-cli.test.ts",),
    "src/plugins/archive.ts": ("test/plugins-archive.test.ts",),
    "src/remote/transfer.ts": ("test/remote-transfer.test.ts",),
    "src/remote/committed.ts": ("test/remote-committed-work.test.ts",),
    "src/task/review.ts": ("test/task-review-request.test.ts",),
    "src/task/handover.ts": ("test/tasks-handover.test.ts",),
    "src/task/admission.ts": ("test/tasks-admission-golden.test.ts",),
    "src/dispatch/learning.ts": ("test/dispatch-learning.test.ts",),
    "src/dispatch/parity.ts": ("test/session-dispatch-parity.test.ts",),
    "src/agent/detect.ts": ("test/agent-detect.test.ts",),
    "src/agent/claude-trust.ts": ("test/claude-trust.test.ts",),
    "src/agent/messaging.ts": ("test/messaging-turns.test.ts", "test/messaging-user-retry.test.ts"),
    "src/tokens/extract.ts": ("test/tokens-extract.test.ts",),
    "src/project/routing.ts": ("test/project-routing-identity.test.ts",),
    "src/project/strategies.ts": ("test/project-strategies.test.ts",),
    "src/project/policy.ts": ("test/project-task-policy.test.ts",),
    "src/usage/metered.ts": ("test/usage-metered-cost.test.ts",),
    "src/usage/refresh.ts": ("test/cli-usage-refresh.test.ts",),
    "src/config/migrate.ts": ("test/config-migrate.test.ts",),
    "src/config/edit.ts": ("test/config-edit.test.ts",),
    "src/install/txn.ts": ("test/install-txn.test.ts",),
    "src/install/reconcile.ts": ("test/install-reconcile.test.ts",),
    "src/install/planner.ts": ("test/install-planner-account.test.ts",),
    "src/install/created.ts": ("test/install-created-refresh.test.ts",),
    "src/desktop/update.ts": ("test/desktop-update-adapter.test.ts", "test/desktop-update-command.test.ts", "test/desktop-update-identity.test.ts", "test/desktop-update-fixture-cleanup.test.ts"),
    "src/desktop/version.ts": ("test/app-desktop-version.test.ts",),
    "src/core/boundaries.ts": ("test/core-boundaries.test.ts", "test/core-auto-migrate.test.ts", "test/core-evidence.test.ts", "test/core-opencode-setup.test.ts"),
    "src/serve/snapshot.ts": ("test/serve-snapshot-cache.test.ts",),
    "src/serve/tui.ts": ("test/serve-tui-human.test.ts",),
    "src/live/updater.ts": ("test/live-updater.test.ts",),
    "src/live/upgrade.ts": ("test/live-upgrade.test.ts",),
    "src/live/ota.ts": ("test/live-ota-evidence.test.ts", "test/live-ota-adoption-outcome.test.ts", "test/live-ota-evidence.test.ts"),
    "src/statusline.ts": ("test/statusline-counts.test.ts",),
    "src/repo/branch.ts": ("test/repo-branch-cache.test.ts",),
    "src/session/viewers.ts": ("test/session-viewers.test.ts",),
    "src/session/agent-overhead.ts": ("test/session-agent-overhead.test.ts",),
    "src/session/keys.ts": ("test/session-keys.test.ts",),
    "src/session/control.ts": ("test/session-control.test.ts",),
    "src/setup/checklist.ts": ("test/setup-checklist.test.ts",),
    "src/setup/git-isolation.ts": ("test/setup-git-isolation.test.ts",),
    "src/setup/snapshot.ts": ("test/setup-snapshot-probe.test.ts",),
    "src/api/snapshot-probe-bridge.ts": ("test/native-snapshot-get-parity.test.ts",),
    "src/host/clean.ts": ("test/host-clean.test.ts",),
    "src/commands/account.ts": ("test/commands-account-picker.test.ts",),
    "src/short-title.ts": ("test/short-title.test.ts",),
    "src/runner/owned.ts": ("test/runner-owned-direct-process.test.ts",),
    "src/supervisor/worktree.ts": ("test/supervisor-worktree.test.ts",),
    "src/app/terminal.ts": ("test/app-terminal-panel-live.test.ts",),
    "src/app/workspace.ts": ("test/app-workspace-terminal-browser.test.ts",),
    "src/app/frame.ts": ("test/app-frame-terminal-live.test.ts",),
    "src/app/dispatch.ts": ("test/app-dispatch-panels-live.test.ts",),
    "src/app/tray.ts": ("test/app-tray-layout-browser.test.ts",),
    "src/app/model.ts": ("test/app-model-wizard.test.ts",),
    "src/app/client.ts": ("test/app-client-control.test.ts", "test/client-control.test.ts"),
    "src/app/task-history.ts": ("test/app-task-history-api.test.ts",),
    "src/app/platform.ts": ("test/app-platform-adapter.test.ts",),
    "src/app/executor.ts": ("test/app-executor-draft.test.ts",),
}


def focused(paths, source_allowed=True):
    """Use a reduced suite only for explicitly audited paths."""
    if any(re.fullmatch(r"docs/(?:plugin-)?protocol(?:-v\d+)?\.(?:md|json)", p) for p in paths):
        return []
    relevant = paths
    mapped = {".github/workflows/ci.yml",
              ".github/workflows/release.yml", ".github/workflows/release-tag.yml",
              ".github/workflows/release-prepare.yml",
              "scripts/ci/changes.py"}
    if relevant and all(p in mapped for p in relevant):
        return list(CI_TESTS)
    if source_allowed and relevant and all(p in SOURCE_TESTS for p in relevant):
        return sorted({test for path in relevant for test in SOURCE_TESTS[path]})
    return []


def plan(paths, source_allowed=True):
    result = select(paths)
    tests = focused(paths, source_allowed)
    if tests and all(p not in SOURCE_TESTS for p in paths):
        result.update(bun=True, rust=False, e2e=False, ui=False)
    result["full"] = not bool(tests)
    result["focused_tests"] = tests
    return result


def git_paths(event, event_name):
    if event_name == "pull_request":
        pr = event["pull_request"]
        base, head = pr["base"]["sha"], pr["head"]["sha"]
        separator = "..."
    elif event_name == "push":
        base, head = event["before"], event["after"]
        separator = ".."
    else:
        raise ValueError("event requires full validation")
    if not all(re.fullmatch(r"[a-fA-F0-9]{40}", sha) and int(sha, 16) for sha in (base, head)):
        raise ValueError("missing or invalid diff endpoints")
    # Disable rename detection: a move must select both its old and new areas.
    output = subprocess.check_output([
        "git", "diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", base + separator + head, "--"
    ])
    fields = output.split(b"\0")[:-1]
    if len(fields) % 2:
        raise ValueError("invalid diff output")
    entries = [(os.fsdecode(fields[i]), os.fsdecode(fields[i + 1])) for i in range(0, len(fields), 2)]
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paths-json", help="classify an explicit JSON path array")
    args = parser.parse_args()
    if args.paths_json is not None:
        paths = json.loads(args.paths_json)
        if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
            parser.error("paths must be an array of strings")
        print(json.dumps(plan(paths), sort_keys=True))
        return
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    event = {}
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        entries = git_paths(event, event_name)
        paths = [path for _, path in entries]
        source_allowed = event_name == "pull_request" and all(status == "M" for status, _ in entries)
        result = plan(paths, source_allowed)
        reason = f"classified {len(paths)} changed paths"
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        result = dict.fromkeys(KEYS, True)
        result["full"] = True
        result["focused_tests"] = []
        reason = f"full validation: {type(error).__name__}"
    result["focused_tests"] = json.dumps(result["focused_tests"], separators=(",", ":"))
    result["timings"] = event_name == "push" and result["rust"]
    lines = [f"{key}={str(value).lower() if isinstance(value, bool) else value}" for key, value in result.items()]
    print(reason + "\n" + "\n".join(lines))
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("\n".join(lines) + "\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write("## Selected CI work\n\n" + reason + "\n\n" + "\n".join(f"- {line}" for line in lines) + "\n")


if __name__ == "__main__":
    main()
