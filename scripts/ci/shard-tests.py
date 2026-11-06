#!/usr/bin/env python3
"""Shard test files for parallel CI execution."""
import json
import os
import subprocess
import sys
from pathlib import Path


def get_test_files():
    """Get all test files by scanning the filesystem (faster than bun test --list)."""
    test_files = []
    # Scan test/ directory and scripts/spike/ for test files
    for root in ("test", "scripts/spike"):
        root_path = Path(root)
        if root_path.exists():
            for test_file in root_path.rglob("*.test.ts"):
                test_files.append(str(test_file))
            for test_file in root_path.rglob("*.test.tsx"):
                test_files.append(str(test_file))
    # Also check conformance/
    conformance_path = Path("conformance")
    if conformance_path.exists():
        for test_file in conformance_path.rglob("*.test.ts"):
            test_files.append(str(test_file))
    return sorted(test_files)


def shard_tests(test_files, shard_count, shard_index):
    """Distribute test files across shards using round-robin for balance."""
    return test_files[shard_index::shard_count]


def main():
    shard_count = int(os.environ.get("SHARD_COUNT", "4"))
    shard_index = int(os.environ.get("SHARD_INDEX", "0"))

    test_files = get_test_files()
    if not test_files:
        print("No test files found", file=sys.stderr)
        sys.exit(1)

    shard_files = shard_tests(test_files, shard_count, shard_index)

    # Output as JSON for the workflow to consume
    print(json.dumps(shard_files))


if __name__ == "__main__":
    main()