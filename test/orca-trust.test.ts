import {expect, test} from "bun:test";
import {chmodSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx} from "./helpers";
import {trustClaudeWorktree} from "../src/exec/claude-trust";
import {removeClaudeTrust} from "../src/exec/claude-trust";

test("Claude trust adds only the target and preserves unrelated config and mode", () => {
  const ctx = fakeCtx();
  const config = join(ctx.home, ".claude.json");
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(config, JSON.stringify({theme: "dark", projects: {"/other": {hasTrustDialogAccepted: true}, "/target": {note: "keep"}}}));
  chmodSync(config, 0o640);
  trustClaudeWorktree(ctx, "/target", config, "task-1");
  const data = JSON.parse(readFileSync(config, "utf8"));
  expect(data).toEqual({theme: "dark", projects: {"/other": {hasTrustDialogAccepted: true}, "/target": {note: "keep", hasTrustDialogAccepted: true}}});
  expect(statSync(config).mode & 0o777).toBe(0o640);
  const records = JSON.parse(readFileSync(join(ctx.pacerHome, "orca", "trusted.json"), "utf8"));
  expect(records).toMatchObject([{path: "/target", configFile: config, taskId: "task-1"}]);
  trustClaudeWorktree(ctx, "/target", config, "task-2");
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "orca", "trusted.json"), "utf8"))).toHaveLength(1);
  removeClaudeTrust(ctx, "task-1", () => false);
  expect(JSON.parse(readFileSync(config, "utf8")).projects["/target"].hasTrustDialogAccepted).toBe(true);
  removeClaudeTrust(ctx, "task-1", () => true);
  expect(JSON.parse(readFileSync(config, "utf8")).projects).toEqual({"/other": {hasTrustDialogAccepted: true}, "/target": {note: "keep"}});
  expect(statSync(config).mode & 0o777).toBe(0o640);
});

test("pre-trusted worktree is not recorded or removed", () => {
  const ctx = fakeCtx();
  const config = join(ctx.home, ".claude.json");
  writeFileSync(config, JSON.stringify({projects: {"/target": {hasTrustDialogAccepted: true}}}));
  trustClaudeWorktree(ctx, "/target", config, "task-1");
  expect(readFileSync(config, "utf8")).toBe(JSON.stringify({projects: {"/target": {hasTrustDialogAccepted: true}}}));
});

test("cleanup leaves a trust entry changed by the user", () => {
  const ctx = fakeCtx();
  const config = join(ctx.home, ".claude.json");
  trustClaudeWorktree(ctx, "/target", config, "task-1");
  const data = JSON.parse(readFileSync(config, "utf8"));
  data.projects["/target"].note = "user change";
  writeFileSync(config, JSON.stringify(data));
  removeClaudeTrust(ctx, "task-1", () => true);
  expect(JSON.parse(readFileSync(config, "utf8")).projects["/target"]).toEqual({hasTrustDialogAccepted: true, note: "user change"});
});

test("Claude trust retries once and keeps a concurrent config edit", () => {
  const ctx = fakeCtx();
  const config = join(ctx.home, ".claude.json");
  writeFileSync(config, JSON.stringify({projects: {}, theme: "light"}));
  let changed = false;
  trustClaudeWorktree(ctx, "/target", config, "task-1", () => {
    if (!changed) { changed = true; writeFileSync(config, JSON.stringify({projects: {}, theme: "dark"})); }
  });
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({projects: {"/target": {hasTrustDialogAccepted: true}}, theme: "dark"});
});

test("a failed trust record write restores the config entry", () => {
  const ctx = fakeCtx();
  const config = join(ctx.home, ".claude.json");
  writeFileSync(config, JSON.stringify({projects: {}}));
  expect(() => trustClaudeWorktree(ctx, "/target", config, "task-1", () => {
    mkdirSync(join(ctx.pacerHome, "orca", "trusted.json"), {recursive: true});
  })).toThrow();
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({projects: {}});
});
