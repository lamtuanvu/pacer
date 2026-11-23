#!/usr/bin/env python3
"""Partition test files across CI shards by measured duration.

Prints a JSON list of test files. Environment:
  SHARD_COUNT, SHARD_INDEX   which shard to print (default: shard 0 of 8)
  SHARD_EXCLUDE_MACOS=1      leave out files that only do work on macOS
  SHARD_TIMINGS              durations file (default: test-timings.json here)
  SHARD_MACOS_MANIFEST       macOS manifest (default: macos-tests.txt here)

--macos prints the files the macOS job runs. --check-macos-manifest fails when a
test file that branches on darwin is missing from the manifest.
"""
import json
import os
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
KINDS = ("only", "mixed", "linux")
ORCA_KIT = re.compile(r"""from\s+['"]orca/testing['"]""")
DARWIN_CHECK = re.compile(r"""(?:process\.platform|\bplatform\(\))\s*[!=]==?\s*['"]darwin['"]""")


def needs_orca_kit(path):
    """Plugin tests that import Orca's `orca/testing` kit only run under `orca plugin test`."""
    return bool(ORCA_KIT.search(Path(path).read_text(errors="replace")))


def get_test_files():
    """Get all test files by scanning the filesystem (faster than bun test --list)."""
    test_files = []
    for root in ("test", "scripts/spike", "conformance", "plugins"):
        root_path = Path(root)
        if root_path.exists():
            for pattern in ("*.test.ts", "*.test.tsx"):
                for path in root_path.rglob(pattern):
                    if "node_modules" in path.parts or ".orca" in path.parts:
                        continue
                    if root == "plugins" and needs_orca_kit(path):
                        continue
                    test_files.append(str(path))
    return sorted(set(test_files))


def load_durations(path):
    durations = json.loads(Path(path).read_text())
    if not isinstance(durations, dict) or not all(
        isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds >= 0
        for seconds in durations.values()
    ):
        raise ValueError(f"{path} must map test files to non-negative seconds")
    return durations


def load_manifest(path):
    """Read `<kind> <file>` lines into {file: kind}."""
    manifest = {}
    for number, raw in enumerate(Path(path).read_text().splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.split()
        if len(fields) != 2 or fields[0] not in KINDS or fields[1] in manifest:
            raise ValueError(f"{path}:{number}: expected a unique '<{'|'.join(KINDS)}> <file>' line")
        manifest[fields[1]] = fields[0]
    return manifest


def shard_tests(test_files, shard_count, durations):
    """Greedy longest-processing-time packing; unknown files count as the median."""
    default = statistics.median(durations.values()) if durations else 1.0
    weighted = sorted(((durations.get(name, default), name) for name in set(test_files)),
                      key=lambda item: (-item[0], item[1]))
    shards = [[] for _ in range(shard_count)]
    loads = [0.0] * shard_count
    for seconds, name in weighted:
        target = min(range(shard_count), key=lambda index: (loads[index], index))
        shards[target].append(name)
        loads[target] += seconds
    return [sorted(shard) for shard in shards]


def manifest_problems(manifest, test_files):
    known = set(test_files)
    problems = [f"{name}: listed in the macOS manifest but does not exist" for name in sorted(set(manifest) - known)]
    for name in test_files:
        if name not in manifest and DARWIN_CHECK.search(Path(name).read_text(errors="replace")):
            problems.append(f"{name}: checks for darwin but is missing from the macOS manifest")
    return problems


def main():
    manifest_path = os.environ.get("SHARD_MACOS_MANIFEST", HERE / "macos-tests.txt")
    timings_path = os.environ.get("SHARD_TIMINGS", HERE / "test-timings.json")
    arguments = sys.argv[1:]
    if arguments not in ([], ["--macos"], ["--check-macos-manifest"]):
        sys.exit("usage: shard-tests.py [--macos | --check-macos-manifest]")
    test_files = get_test_files()
    if not test_files:
        sys.exit("No test files found")
    manifest = load_manifest(manifest_path)
    if arguments == ["--check-macos-manifest"]:
        problems = manifest_problems(manifest, test_files)
        if problems:
            sys.exit("\n".join(problems))
        return
    if arguments == ["--macos"]:
        print(json.dumps(sorted(name for name, kind in manifest.items() if kind != "linux")))
        return

    shard_count = int(os.environ.get("SHARD_COUNT", "8"))
    shard_index = int(os.environ.get("SHARD_INDEX", "0"))
    if shard_count < 1 or not 0 <= shard_index < shard_count:
        sys.exit("SHARD_INDEX must be below a positive SHARD_COUNT")
    if os.environ.get("SHARD_EXCLUDE_MACOS") == "1":
        test_files = [name for name in test_files if manifest.get(name) != "only"]
    print(json.dumps(shard_tests(test_files, shard_count, load_durations(timings_path))[shard_index]))


if __name__ == "__main__":
    main()
