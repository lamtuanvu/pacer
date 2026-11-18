#!/usr/bin/env python3
"""Regenerate test-durations.json from the Linux shard logs of a full CI run.

Usage: python3 scripts/ci/update-test-durations.py --run <run-id>
       python3 scripts/ci/update-test-durations.py --logs <directory of *.log files>

Bun runs a shard's files one at a time and opens a log group per file, so a file
lasts from its group's first timestamp until the next file's group or the summary.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess

OUTPUT = Path(__file__).with_name("test-durations.json")
JOB_PREFIX = "Test (ubuntu-latest, shard "
GROUP = re.compile(r"^(\S+) ##\[group\](\S+\.test\.tsx?):\s*$")
SUMMARY = re.compile(r"^(\S+) Ran \d+ tests? across \d+ files?\.")


def timestamp(text):
    whole, _, fraction = text.rstrip("Z").partition(".")
    moment = datetime.strptime(whole, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return moment.timestamp() + float(f"0.{fraction or 0}")


def parse_log(text):
    """Return {file: seconds} for one shard's log."""
    starts, end = [], None
    for line in text.lstrip("﻿").splitlines():
        group = GROUP.match(line)
        summary = SUMMARY.match(line)
        if group:
            starts.append((group[2], timestamp(group[1])))
        elif summary and starts:
            end = timestamp(summary[1])
    durations = {}
    for index, (name, start) in enumerate(starts):
        finish = starts[index + 1][1] if index + 1 < len(starts) else end
        if finish is not None:
            durations[name] = round(max(finish - start, 0.0), 2)
    return durations


def run_logs(run):
    jobs = subprocess.check_output(["gh", "api", "--paginate", f"repos/{{owner}}/{{repo}}/actions/runs/{run}/jobs?per_page=100",
                                    "--jq", f'.jobs[] | select(.name | startswith("{JOB_PREFIX}")) | .id'], text=True).split()
    return [subprocess.check_output(["gh", "api", f"repos/{{owner}}/{{repo}}/actions/jobs/{job}/logs"], text=True) for job in jobs]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--run", help="GitHub Actions run id of a full CI run")
    source.add_argument("--logs", type=Path, help="directory of downloaded shard logs")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    logs = run_logs(args.run) if args.run else [path.read_text(errors="replace") for path in sorted(args.logs.glob("*.log"))]
    durations = {}
    for log in logs:
        durations.update(parse_log(log))
    if not durations:
        raise SystemExit("No per-file timings found; was this a full CI run?")
    args.output.write_text(json.dumps(dict(sorted(durations.items())), indent=0) + "\n")
    print(f"{len(durations)} files, {sum(durations.values()):.0f}s total")


if __name__ == "__main__":
    main()
