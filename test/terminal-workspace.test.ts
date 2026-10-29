import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import * as workspace from "../src/terminal/workspace";

test("a shell terminal is private, survives a fresh read, and stops when closed", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  const created = await workspace.createTerminal(ctx, { requestId: "shell-one", kind: "shell", title: "Shell", cwd: ctx.home });
  try {
    let live = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      live = (await workspace.getTerminal(ctx, created.id)).live;
      if (live) break;
      await Bun.sleep(50);
    }
    expect(live).toBe(true);
    expect(created.cwd).toBe(realpathSync(ctx.home));
    expect(created.attach.ws).toBe(`/v3/terminals/${created.id}/session`);
    expect(statSync(join(ctx.pacerHome, "terminals")).mode & 0o777).toBe(0o700);
    expect(statSync(join(ctx.pacerHome, "terminals", created.id, "record.json")).mode & 0o777).toBe(0o600);
    const listed = await workspace.listTerminals(ctx);
    expect(listed.map(t => t.id)).toContain(created.id);
    expect(await workspace.getTerminal(ctx, created.id)).toMatchObject({ id: created.id, cwd: realpathSync(ctx.home), rev: 1 });
  } finally {
    const latest = await workspace.getTerminal(ctx, created.id);
    await workspace.closeTerminal(ctx, created.id, latest.rev);
  }
  expect(await workspace.listTerminals(ctx)).toEqual([]);
});

test("request IDs reserve one launch and reject a changed payload", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  const launches: string[] = [];
  const start = (spec: { dir: string }) => { launches.push(spec.dir); return { pid: 12345 }; };
  const input = { requestId: "one-launch", kind: "action" as const, title: "Check", cwd: ctx.home, argv: ["true"] };
  const [first, second] = await Promise.all([
    workspace.createTerminal(ctx, input, { start }),
    workspace.createTerminal(ctx, input, { start }),
  ]);
  expect(first.id).toBe(second.id);
  expect(launches).toHaveLength(1);
  await expect(workspace.createTerminal(ctx, { ...input, title: "Different" }, { start })).rejects.toMatchObject({ code: "conflict" });
});

test("a failed launch remains reserved and never runs again on retry", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  let calls = 0;
  const start = () => { calls++; return { error: "spawn failed" }; };
  const input = { requestId: "failed-launch", kind: "action" as const, title: "Check", cwd: ctx.home, argv: ["true"] };
  await expect(workspace.createTerminal(ctx, input, { start })).rejects.toMatchObject({ code: "not_allowed" });
  await expect(workspace.createTerminal(ctx, input, { start })).rejects.toMatchObject({ code: "conflict" });
  expect(calls).toBe(1);
  expect(readFileSync(join(ctx.pacerHome, "terminals", "requests.json"), "utf8")).toContain("failed-launch");
});

test("rename and close use a revision and never signal an unrelated process", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  const terminal = await workspace.createTerminal(ctx, { requestId: "rename-one", kind: "action", title: "Before", cwd: ctx.home, argv: ["true"] }, { start: () => ({ pid: 99999999 }) });
  const renamed = await workspace.renameTerminal(ctx, terminal.id, "After", terminal.rev);
  expect(renamed.title).toBe("After");
  await expect(workspace.renameTerminal(ctx, terminal.id, "Again", terminal.rev)).rejects.toMatchObject({ code: "conflict" });
  await expect(workspace.closeTerminal(ctx, terminal.id, terminal.rev)).rejects.toMatchObject({ code: "conflict" });
  await workspace.closeTerminal(ctx, terminal.id, renamed.rev);
  expect(existsSync(join(ctx.pacerHome, "terminals", terminal.id, "record.json"))).toBe(true);
  await expect(workspace.getTerminal(ctx, terminal.id)).rejects.toMatchObject({ code: "invalid_input" });
});
test("terminal children do not inherit service or executor credentials", async () => {
  const ctx = fakeCtx({env:{...process.env,PACER_WORK_GRANT:"private",PACER_INTERNAL_TOKEN:"private",PACER_ROLE:"executor"}});
  let spawned: Record<string,string|undefined> = {};
  await workspace.createTerminal(ctx,{requestId:"clean-env",kind:"action",title:"Safe",argv:["true"]},{start:spec=>{spawned=spec.env;return {pid:99999999};}});
  expect(spawned.PACER_WORK_GRANT).toBeUndefined();
  expect(spawned.PACER_INTERNAL_TOKEN).toBeUndefined();
  expect(spawned.PACER_ROLE).toBeUndefined();
  expect(spawned.HOME).toBe(ctx.home);
});

test("automatic shell titles name the login executable and preserve the requested working folder", async () => {
  const ctx = fakeCtx({ env: { ...process.env, SHELL: "/bin/sh" } });
  let launched: import("../src/supervisor/run").RunSpec | undefined;
  const tab = await workspace.createTerminal(ctx, { requestId: "login-title", kind: "shell", cwd: ctx.home }, {
    start: spec => { launched = spec; return { pid: 99999999 }; },
  });
  expect(launched!.argv[1]).toBe("-l");
  expect(tab.title).toBe(launched!.argv[0]!.split("/").at(-1)!);
  expect(launched!.env.SHELL).toBe(launched!.argv[0]);
  expect(launched!.cwd).toBe(realpathSync(ctx.home));
});
