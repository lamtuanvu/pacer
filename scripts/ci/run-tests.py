#!/usr/bin/env python3
"""Run one CI shard, or with --macos the macOS-specific files, under bun test."""
import json
import os
from pathlib import Path
import subprocess
import sys

listing = subprocess.run([sys.executable, str(Path(__file__).with_name("shard-tests.py")), *sys.argv[1:]],
                         check=True, stdout=subprocess.PIPE, text=True).stdout
files = json.loads(listing)
if not files:
    sys.exit("No test files selected")
# Bun treats a bare path as a substring filter; ./ selects exactly that file.
command = ["bun", "test", "--timeout", "30000", *(f"./{name}" for name in files)]
os.execvpe("bun", command, {**os.environ, "TZ": "Asia/Ho_Chi_Minh"})
