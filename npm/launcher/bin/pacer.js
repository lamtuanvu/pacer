#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const expected = `@lamtuanvu/pacer-${process.platform}-${process.arch}`;
function unavailable(reason) {
  console.error(`pacer: ${reason}. Expected platform package: ${expected}. Reinstall @lamtuanvu/pacer with optional dependencies enabled (without --omit=optional). Alternatives: install.sh at https://github.com/lamtuanvu/pacer or Homebrew (brew install lamtuanvu/tap/pacer).`);
  process.exit(1);
}
let binary = process.env.PACER_BINARY_PATH;
if (!binary) {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    unavailable(`unsupported platform ${process.platform}-${process.arch}`);
  }
  try {
    binary = require.resolve(`${expected}/bin/pacer`);
  } catch (error) {
    unavailable(`cannot resolve ${expected}/bin/pacer: ${error.message}`);
  }
}
const child = spawnSync(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, PACER_INSTALL_METHOD: "npm" },
});
if (child.error) {
  console.error(`pacer: failed to run ${binary}: ${child.error.message}`);
  process.exit(1);
}
if (child.signal) {
  process.kill(process.pid, child.signal);
} else {
  process.exit(child.status === null ? 1 : child.status);
}
