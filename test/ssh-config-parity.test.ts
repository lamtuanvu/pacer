import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshAliases, sshSuggestions } from "../src/remote/ssh-config";
import { tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");

function sshBinary() {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "ssh_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
  );
  return join(metadata.target_directory, "debug/examples/ssh_diff");
}

function rustLines(cases: unknown[]) {
  const bin = sshBinary();
  const out = execFileSync(bin, [], { input: cases.map(c => JSON.stringify(c)).join("\n") + "\n", encoding: "utf8" });
  return out.trim().split("\n").map(line => JSON.parse(line));
}

function fixture() {
  const home = tmpDir();
  const ssh = join(home, ".ssh");
  mkdirSync(join(ssh, "conf.d"), { recursive: true });
  return { home, ssh };
}

test("sshSuggestions match Rust across fixture corpus", () => {
  const { home, ssh } = fixture();
  writeFileSync(
    join(ssh, "config"),
    'Host devbox gpu-box\nHost * !private qa?\nInclude conf.d/*\nHost devbox\n',
  );
  writeFileSync(join(ssh, "conf.d/a"), "Host staging\nInclude ~/.ssh/extra\n");
  writeFileSync(join(ssh, "extra"), 'hOsT="quoted-box" # comment\n');
  const [aliases, detail] = rustLines([
    { op: "aliases", home },
    { op: "detail", home },
  ]);
  expect(sshAliases(home)).toEqual(aliases.names);
  expect(sshSuggestions(home)).toEqual(detail.rows);
});

test("suggest_hosts filtering matches Rust", () => {
  const { home, ssh } = fixture();
  writeFileSync(join(ssh, "config"), "Host fresh-box\nHost devbox\n");
  const [plain, detailed] = rustLines([
    { op: "suggestions", home, used: ["devbox"], details: false },
    { op: "suggestions", home, used: ["devbox"], details: true },
  ]);
  expect(plain.result).toEqual(["fresh-box"]);
  expect(detailed.result).toEqual([{ name: "fresh-box", host: "fresh-box" }]);
});
