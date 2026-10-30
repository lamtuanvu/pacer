import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshAliases, sshSuggestions } from "../src/remote/ssh-config";
import { tmpDir } from "./helpers";

function fixture() {
  const home = tmpDir(), ssh = join(home, ".ssh");
  mkdirSync(join(ssh, "conf.d"), { recursive: true });
  return { home, ssh };
}
test("concrete aliases include multiple names and globbed Includes, excluding patterns", () => {
  const { home, ssh } = fixture();
  writeFileSync(join(ssh, "config"), 'Host devbox gpu-box\nHost * !private qa?\nInclude conf.d/*\nHost devbox\n');
  writeFileSync(join(ssh, "conf.d", "a"), 'Host staging\nInclude ~/.ssh/extra\n');
  writeFileSync(join(ssh, "extra"), 'hOsT="quoted-box" # comment\n');
  expect(sshAliases(home)).toEqual(["devbox", "gpu-box", "staging", "quoted-box"]);
});
test("Include paths are relative to .ssh, support quoted paths, and missing includes are ignored", () => {
  const { home, ssh } = fixture();
  writeFileSync(join(ssh, "config"), 'Include "with space" missing\nInclude conf.d/a\n');
  writeFileSync(join(ssh, "with space"), 'Host spaced\n');
  writeFileSync(join(ssh, "conf.d", "a"), 'Include extra\n');
  writeFileSync(join(ssh, "extra"), 'Host nested\n');
  expect(sshAliases(home)).toEqual(["spaced", "nested"]);
  expect(sshAliases(tmpDir())).toEqual([]);
});
test("Includes stop after eight levels and cycles terminate", () => {
  const { home, ssh } = fixture();
  writeFileSync(join(ssh, "config"), 'Include level1\nInclude config\n');
  for (let i = 1; i <= 9; i++) writeFileSync(join(ssh, `level${i}`), `Host level${i}\nInclude level${i + 1}\n`);
  expect(sshAliases(home)).toEqual(["level1", "level2", "level3", "level4", "level5", "level6", "level7", "level8"]);
});

test("suggestions include HostName, first matching values, wildcard defaults and Include context", () => {
  const { home, ssh } = fixture();
  writeFileSync(join(ssh, "config"), 'Host devbox gpu-box\nInclude conf.d/name\nHost devbox\nHostName ignored.invalid\nHost *.lab !private.lab\nHostName %h.example\nHost staging.lab private.lab fallback\n');
  writeFileSync(join(ssh, "conf.d", "name"), 'HostName 192.0.2.1\n');
  expect(sshSuggestions(home)).toEqual([
    {name:"devbox",host:"192.0.2.1"},{name:"gpu-box",host:"192.0.2.1"},
    {name:"staging.lab",host:"staging.lab.example"},{name:"private.lab",host:"private.lab"},{name:"fallback",host:"fallback"},
  ]);
});
