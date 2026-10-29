import { beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { cachedMachineId, clearIdentityCache, ensureIdentity, machineView, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected } from "../src/identity/salt";
import { signFor, verifyFrom } from "../src/identity/sign";
import type { Ctx } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

const src = join(import.meta.dir, "..", "src");

/** Run `body` in a separate bun process on the same file-backend home, the way a second core or CLI would. */
async function inChild(ctx: Ctx, body: string): Promise<Record<string, unknown>> {
  const script = join(tmpDir(), "child.ts");
  writeFileSync(script, `
import { setIdentityPlatformForTests } from ${JSON.stringify(join(src, "identity", "store"))};
import { rotateIdentity } from ${JSON.stringify(join(src, "identity", "rotate"))};
import { setMachineName, ensureIdentity, readMeta, writeMeta } from ${JSON.stringify(join(src, "identity", "store"))};
setIdentityPlatformForTests("linux");
const ctx = { home: ${JSON.stringify(ctx.home)}, pacerHome: ${JSON.stringify(ctx.pacerHome)}, now: ${ctx.now}, env: {},
  run: async () => ({ code: 127, stdout: "", stderr: "" }), which: () => null };
const out = await (async () => { ${body} })();
console.log(JSON.stringify(out ?? {}));
`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`child failed (${code}): ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("a rotation in another process replaces the cached identity, its stamp and its signatures", async () => {
  const ctx = fakeCtx();
  const old = await ensureIdentity(ctx);
  expect(cachedMachineId(ctx)).toBe(old.id);
  const r = await inChild(ctx, "return rotateIdentity(ctx);") as { oldId: string; newId: string };
  expect(r.oldId).toBe(old.id);
  expect(readMeta(ctx)!.publicId).toBe(r.newId);
  expect(cachedMachineId(ctx)).toBe(r.newId);
  const now = await ensureIdentity(ctx);
  expect(now.id).toBe(r.newId);
  expect(machineView(now, await cloneSuspected(ctx)).id).toBe(r.newId);
  const payload = new TextEncoder().encode("hello");
  const s = await signFor(ctx, "fx", "probe", payload);
  expect(s.machineId).toBe(r.newId);
  expect(verifyFrom(r.newId, "fx", "probe", payload, s.signature)).toBe(true);
  expect(verifyFrom(old.id, "fx", "probe", payload, s.signature)).toBe(false);
}, 30000);

test("a rename in another process is seen without a restart", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx);
  await inChild(ctx, `return setMachineName(ctx, "studio", ${before.rev});`);
  const now = await ensureIdentity(ctx);
  expect(now.name).toBe("studio");
  expect(now.rev).toBe(before.rev + 1);
}, 30000);

test("a copied-home flag recorded by another process is seen by cloneSuspected", async () => {
  const ctx = fakeCtx();
  await ensureIdentity(ctx);
  expect(await cloneSuspected(ctx)).toBe(false);
  await inChild(ctx, "const m = readMeta(ctx); writeMeta(ctx, { ...m, cloneDetected: true, cloneDetectedAt: ctx.now });");
  expect(await cloneSuspected(ctx)).toBe(true);
}, 30000);

test("an unchanged machine.json keeps serving the cached identity", async () => {
  const ctx = fakeCtx();
  const a = await ensureIdentity(ctx);
  expect(await ensureIdentity(ctx)).toBe(a);
});
