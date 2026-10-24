"""Select CI work from complete git diffs, without third-party dependencies."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

KEYS = ("bun", "rust", "e2e", "ui", "codeql")


def select(paths):
    result = dict.fromkeys(KEYS, False)
    for path in paths:
        # These generated documents have freshness tests, unlike ordinary prose.
        if re.fullmatch(r"docs/(?:plugin-)?protocol(?:-v\d+)?\.(?:md|json)", path):
            result["bun"] = True
        elif path.endswith(".md"):
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
            # Native presentation and bundle parity also have Bun tests.
            result["bun"] = result["ui"] = result["codeql"] = True
        else:
            # Shared configuration, workflows, scripts and unknown new areas:
            # err on the side of coverage until their dependencies are mapped.
            return dict.fromkeys(KEYS, True)
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
        "git", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base + separator + head, "--"
    ])
    return [os.fsdecode(path) for path in output.split(b"\0") if path]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paths-json", help="classify an explicit JSON path array")
    args = parser.parse_args()
    if args.paths_json is not None:
        paths = json.loads(args.paths_json)
        if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
            parser.error("paths must be an array of strings")
        print(json.dumps(select(paths), sort_keys=True))
        return
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    event = {}
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        paths = git_paths(event, event_name)
        result = select(paths)
        reason = f"classified {len(paths)} changed paths"
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        result = dict.fromkeys(KEYS, True)
        reason = f"full validation: {type(error).__name__}"
    result["timings"] = event_name == "push" and result["rust"]
    lines = [f"{key}={str(value).lower()}" for key, value in result.items()]
    print(reason + "\n" + "\n".join(lines))
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("\n".join(lines) + "\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write("## Selected CI work\n\n" + reason + "\n\n" + "\n".join(f"- {line}" for line in lines) + "\n")


if __name__ == "__main__":
    main()
