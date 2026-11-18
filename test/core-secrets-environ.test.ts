import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_SECRET_ENV } from "../src/core-secrets";
import { childPids, processArgs } from "./fixtures/process-environ";
import { front, makeHome, ownerOn, recordingMain, serve, stdio, tsOwner } from "./native-plugin-door";

// #918 item 3 (option 2a): any same-user process, sandboxed or not, can read Core's initial
// environment, so the front doors hand Core its secrets on stdin. Neither serve's Core nor the
// stdio door's Core may carry a secret in its environment or argv, owner flag on or off.

async function corePid(parent: number): Promise<number> {
  for (let i = 0; i < 500; i++) {
    for (const pid of childPids(parent)) {
      try {
        if ((await processArgs(pid)).argv.some(arg => arg.endsWith("src/cli.ts"))) return pid;
      } catch { /* The child exited or is still exec'ing. */ }
    }
    await Bun.sleep(20);
  }
  throw Error(`no Core child of pid ${parent}`);
}

async function expectNoSecrets(pid: number, known: string[]) {
  const { argv, env, source } = await processArgs(pid);
  // The probe sees this Core's environment: the home the test gave it is there.
  expect(env.some(entry => entry.startsWith("PACER_HOME=")), source).toBe(true);
  for (const name of CORE_SECRET_ENV) expect(env.filter(entry => entry.startsWith(`${name}=`)), name).toEqual([]);
  const visible = [...argv, ...env].join("\n");
  for (const value of known) expect(visible.includes(value)).toBe(false);
  // Every Core secret is 64 hex digits; none may be visible under any name.
  expect(visible).not.toMatch(/[0-9a-f]{64}/);
}

async function pluginWorks(h: { plugin: string }, call: (op: string, params: unknown) => Promise<{ json: any; line: string }>) {
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  await call("plugin.enable", { id: "fx-ui", grant: true });
  const doctor = await call("plugin.doctor", { id: "fx-ui" });
  expect(doctor.json.result.reports[0].ok, doctor.line).toBe(true);
  expect(readFileSync(join(h.plugin, "inherited-key"), "utf8")).toBe("absent");
  expect(readFileSync(join(h.plugin, "inherited-owner-key"), "utf8")).toBe("absent");
}

test.skipIf(!front)("serve's Core holds no secret in its environment, owner flag on or off", async () => {
  for (const options of [tsOwner, ownerOn]) {
    const h = makeHome(), s = await serve(h, "", options);
    try {
      await pluginWorks(h, s.call);
      const known = options === ownerOn ? [readFileSync(join(h.state, "run", "host.key"), "utf8").trim()] : [];
      await expectNoSecrets(await corePid(s.child.pid), known);
    } finally {
      await s.stop();
      h.done();
    }
  }
}, 120000);

test.skipIf(!front)("the stdio door's Core holds no secret in its environment, owner flag on or off", async () => {
  for (const options of [tsOwner, ownerOn]) {
    const h = makeHome(), s = await stdio(h, "", options);
    try {
      await pluginWorks(h, s.call);
      await expectNoSecrets(await corePid(s.child.pid), []);
    } finally {
      await s.stop();
      h.done();
    }
  }
}, 120000);
