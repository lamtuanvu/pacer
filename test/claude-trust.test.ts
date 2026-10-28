import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigFile, folderKeys, grantClaudeFolderTrust } from "../src/exec/claude-trust";
import { tmpDir } from "./helpers";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const leftovers = (dir: string) => readdirSync(dir).filter(name => name.includes(".pacer-trust-") || name.endsWith(".lock"));

function account(content: Record<string, unknown> = {oauthAccount: {emailAddress: "someone@example.invalid"}, projects: {"/elsewhere": {allowedTools: ["Bash"]}}}) {
  const dir = tmpDir(), file = join(dir, ".claude.json");
  writeFileSync(file, JSON.stringify(content), {mode: 0o600});
  return {dir, file};
}

test("the config file follows Claude's own lookup", () => {
  const home = tmpDir(), dir = tmpDir();
  expect(claudeConfigFile({}, home)).toBe(join(home, ".claude.json"));
  expect(claudeConfigFile({CLAUDE_CONFIG_DIR: ""}, home)).toBe(join(home, ".claude.json"));
  expect(claudeConfigFile({CLAUDE_CONFIG_DIR: dir}, home)).toBe(join(dir, ".claude.json"));
  expect(claudeConfigFile({CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://x.invalid"}, home)).toBe(join(dir, ".claude-custom-oauth.json"));
  writeFileSync(join(dir, ".config.json"), "{}");
  expect(claudeConfigFile({CLAUDE_CONFIG_DIR: dir}, home)).toBe(join(dir, ".config.json"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", ".config.json"), "{}");
  expect(claudeConfigFile({}, home)).toBe(join(home, ".claude", ".config.json"));
});

test("folder keys cover the lexical and the real path", () => {
  const real = tmpDir(), link = join(tmpDir(), "link");
  symlinkSync(real, link);
  expect(folderKeys(link)).toEqual([link, realpathSync.native(real)]);
  expect(folderKeys(join(link, "..", "link"))).toEqual([link, realpathSync.native(real)]);
});

test("a grant trusts the folder, records the import answer on the repository root and keeps everything else", async () => {
  const {dir, file} = account(), folder = tmpDir(), root = tmpDir();
  chmodSync(file, 0o640);
  expect(await grantClaudeFolderTrust(file, folder, root)).toEqual({status: "granted"});
  const config = read(file);
  expect(config.oauthAccount).toEqual({emailAddress: "someone@example.invalid"});
  expect(config.projects["/elsewhere"]).toEqual({allowedTools: ["Bash"]});
  for (const key of folderKeys(folder)) expect(config.projects[key]).toEqual({hasTrustDialogAccepted: true});
  // Recorded as "No": the prompt is not shown and external imports stay off.
  for (const key of folderKeys(root)) expect(config.projects[key]).toEqual({hasClaudeMdExternalIncludesWarningShown: true});
  expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(config, null, 2)}\n`);
  expect(statSync(file).mode & 0o777).toBe(0o640);
  expect(leftovers(dir)).toEqual([]);
});

test("an existing trust and import answer leave the file untouched, including an earlier refusal", async () => {
  const folder = tmpDir(), root = tmpDir();
  const {file} = account({projects: {[folderKeys(folder)[0]]: {hasTrustDialogAccepted: true}, [folderKeys(root)[0]]: {hasClaudeMdExternalIncludesWarningShown: true, hasClaudeMdExternalIncludesApproved: false}}});
  const before = readFileSync(file, "utf8");
  expect(await grantClaudeFolderTrust(file, folder, root)).toEqual({status: "unchanged"});
  expect(readFileSync(file, "utf8")).toBe(before);
  // Trust alone is missing: only the trust entries change.
  const other = tmpDir();
  expect(await grantClaudeFolderTrust(file, other, root)).toEqual({status: "granted"});
  expect(read(file).projects[folderKeys(root)[0]]).toEqual({hasClaudeMdExternalIncludesWarningShown: true, hasClaudeMdExternalIncludesApproved: false});
  expect(read(file).projects[folderKeys(other)[0]]).toEqual({hasTrustDialogAccepted: true});
});

test("unusable config files are reported without their contents and left as they were", async () => {
  const folder = tmpDir();
  expect(await grantClaudeFolderTrust(join(tmpDir(), ".claude.json"), folder)).toEqual({status: "skipped", reason: "the Claude config file does not exist yet"});
  for (const [content, reason] of [
    ["secret-token-123 {", "the Claude config file is not valid JSON"],
    ['["secret-token-123"]', "the Claude config file is not a JSON object"],
    ['{"projects": ["secret-token-123"]}', "the Claude config has a malformed projects entry"],
  ]) {
    const dir = tmpDir(), file = join(dir, ".claude.json");
    writeFileSync(file, content);
    const result = await grantClaudeFolderTrust(file, folder);
    expect(result).toEqual({status: "skipped", reason});
    expect(JSON.stringify(result)).not.toContain("secret-token-123");
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(leftovers(dir)).toEqual([]);
  }
});

test("a held lock is never taken over and the launch proceeds without trust", async () => {
  const {dir, file} = account();
  mkdirSync(`${file}.lock`);
  const before = readFileSync(file, "utf8"), started = Date.now();
  expect(await grantClaudeFolderTrust(file, tmpDir())).toEqual({status: "skipped", reason: "the Claude config file is locked by another process"});
  expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(`${file}.lock`)).toBe(true);
  expect(readdirSync(dir).filter(name => name.includes(".pacer-trust-"))).toEqual([]);
});

test("the file is re-read under the lock so a concurrent writer's change survives", async () => {
  const {file} = account(), folder = tmpDir();
  mkdirSync(`${file}.lock`);
  const grant = grantClaudeFolderTrust(file, folder);
  await Bun.sleep(20);
  writeFileSync(file, JSON.stringify({...read(file), numStartups: 7}));
  rmdirSync(`${file}.lock`);
  expect(await grant).toEqual({status: "granted"});
  expect(read(file).numStartups).toBe(7);
  expect(read(file).projects[folderKeys(folder)[0]]).toEqual({hasTrustDialogAccepted: true});
});

test("a symlinked config file is updated at its target and stays a symlink", async () => {
  const {file: target} = account(), link = join(tmpDir(), ".claude.json");
  symlinkSync(target, link);
  const folder = tmpDir();
  expect(await grantClaudeFolderTrust(link, folder)).toEqual({status: "granted"});
  expect(realpathSync(link)).toBe(realpathSync(target));
  expect(read(target).projects[folderKeys(folder)[0]]).toEqual({hasTrustDialogAccepted: true});
});

test("concurrent grants for one file all land", async () => {
  const {dir, file} = account(), folders = Array.from({length: 6}, () => tmpDir());
  const results = await Promise.all(folders.map(folder => grantClaudeFolderTrust(file, folder)));
  expect(results.every(result => result.status === "granted")).toBe(true);
  for (const folder of folders) expect(read(file).projects[folderKeys(folder)[0]]).toEqual({hasTrustDialogAccepted: true});
  expect(leftovers(dir)).toEqual([]);
});

test("an earlier yes to external imports is kept", async () => {
  const folder = tmpDir(), root = tmpDir();
  const {file} = account({projects: {[folderKeys(root)[0]]: {hasClaudeMdExternalIncludesApproved: true}}});
  expect(await grantClaudeFolderTrust(file, folder, root)).toEqual({status: "granted"});
  expect(read(file).projects[folderKeys(root)[0]]).toEqual({hasClaudeMdExternalIncludesApproved: true});
});

test("temp copies left by a crashed grant are removed on the next grant", async () => {
  const {dir, file} = account();
  const stale = `${file}.pacer-trust-crashed.tmp`, fresh = `${file}.pacer-trust-inflight.tmp`;
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 120_000);
  utimesSync(stale, old, old);
  expect(await grantClaudeFolderTrust(file, tmpDir())).toEqual({status: "granted"});
  expect(existsSync(stale)).toBe(false);
  // A recent temp may belong to a grant in another process.
  expect(existsSync(fresh)).toBe(true);
  expect(readdirSync(dir).filter(name => name.endsWith(".lock"))).toEqual([]);
});
