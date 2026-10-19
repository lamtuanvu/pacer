import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appLink, removePathBlock } from "../src/install/path-block";
import { tmpDir } from "./helpers";

const block = '# >>> pacer >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< pacer <<<';

test.each([
  ["no block", "export EDITOR=vi\n", "export EDITOR=vi\n", false],
  ["middle block", `before\n${block}\n\nafter\n`, "before\n\nafter\n", true],
  ["EOF without newline", `before\n${block}`, "before\n", true],
  ["two blocks", `${block}\nmiddle\n${block}\nend`, "middle\nend", true],
  ["incomplete block", "before\n# >>> pacer >>>\nkeep\n", "before\n# >>> pacer >>>\nkeep\n", false],
  ["inline marker", `echo '${block}'\n`, `echo '${block}'\n`, false],
])("removePathBlock preserves unrelated bytes: %s", (_name, input, expected, removed) => {
  expect(removePathBlock(input as string)).toEqual({ text: expected, removed });
});

test.each(["app", "elsewhere", "regular", "missing"])("appLink identifies only an app symlink: %s", kind => {
  const home = tmpDir();
  const path = join(home, ".local/bin/pacer");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  if (kind === "app") symlinkSync(join(home, "x.app/Contents/MacOS/pacer"), path);
  if (kind === "elsewhere") symlinkSync(join(home, "other/pacer"), path);
  if (kind === "regular") writeFileSync(path, "keep");
  expect(appLink(home)).toBe(kind === "app" ? path : null);
});
