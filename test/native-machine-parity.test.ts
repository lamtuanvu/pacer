import { beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import { verifyFrom } from "../src/identity/sign";
import { rotateIdentity, type RotationStep } from "../src/identity/rotate";
import { clearIdentityCache, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { fakeCtx, tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");
const NOW = 1_700_000_000;
let driver = "";

beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString());
  driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
}, 600_000);
beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

const ctxFor = (home: string) => fakeCtx({ home, pacerHome: home, now: NOW });

function native(home: string, op: string, params: unknown) {
  const input = JSON.stringify({ op, params, home, now: NOW, identityPlatform: "linux" }) + "\n";
  return JSON.parse(execFileSync(driver, [], { input }).toString());
}

async function typescript(home: string, op: string, params: unknown) {
  clearIdentityCache();
  try { return { result: await callOp(ctxFor(home), op, params) }; }
  catch (error) { return { error: toApiError(error) }; }
}

/** Every file under the home with its mode; locks are transient. */
function files(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (!name.endsWith(".lock")) {
        const bytes = readFileSync(path);
        out[relative(home, path)] = `${(st.mode & 0o777).toString(8)} ${name.endsWith(".key") || name.endsWith(".staging") ? bytes.toString("hex") : bytes.toString("utf8")}`;
      }
    }
  };
  walk(home);
  return out;
}

/** Run the op through TypeScript, restore the home at the same path, run it natively. The home keeps the native state. */
async function both(home: string, op: string, params: unknown) {
  const snapshot = tmpDir();
  cpSync(home, snapshot, { recursive: true });
  const ts = { out: await typescript(home, op, params), files: files(home) };
  rmSync(home, { recursive: true, force: true });
  cpSync(snapshot, home, { recursive: true });
  const rs = { out: native(home, op, params), files: files(home) };
  return { ts, rs };
}

/** Activity ids end in two random bytes. */
const stable = (text: string) => text.replace(/("id":"\d+(?:\.\d+)?-)[0-9a-f]{4}"/g, '$1xxxx"');

/** Replace per-run randomness (new key, id, signature, salt) with placeholders. */
function normalize(side: { out: any; files: Record<string, string> }, randomName = false) {
  const meta = JSON.parse(side.files["identity/machine.json"]!.slice(4));
  const swaps: [string, string][] = [];
  const add = (from: unknown, to: string) => { if (typeof from === "string" && from) swaps.push([from, to], [from.slice(0, 8), to.slice(0, 8)]); };
  add(meta.lastRotation?.signature, "<signature>");
  add(meta.publicId, "<machine-id>");
  add(meta.saltHash, "<salt-hash>");
  if (randomName) add(meta.name, "<name>");
  const salt = Object.keys(side.files).find(k => k.includes("install-salt/"));
  if (salt) add(side.files[salt]!.slice(4).trim(), "<salt>");
  const key = side.files["identity/machine.key"];
  if (key) add(key.slice(4), "<key>");
  const audit = side.files["logs/identity-audit.jsonl"];
  for (const m of audit?.matchAll(/"sha256":"([0-9a-f]+)"/g) ?? []) add(m[1], "<sha256>");
  swaps.sort((a, b) => b[0].length - a[0].length);
  const apply = (text: string) => stable(swaps.reduce((t, [from, to]) => t.split(from).join(to), text));
  return { out: JSON.parse(apply(JSON.stringify(side.out))), files: Object.fromEntries(Object.entries(side.files).map(([k, v]) => [k, apply(v)])) };
}

const exact = (side: { out: unknown; files: Record<string, string> }) => ({ out: side.out, files: Object.fromEntries(Object.entries(side.files).map(([k, v]) => [k, stable(v)])) });

test("native machine.get, machine.set and errors match TypeScript on the same home", async () => {
  const home = tmpDir();
  const created = await typescript(home, "machine.get", {});
  expect(created).toHaveProperty("result.rev", 1);

  let r = await both(home, "machine.get", {});
  expect(exact(r.rs)).toEqual(exact(r.ts));
  expect(r.rs.out).toEqual(created);

  r = await both(home, "machine.set", { name: " \u202estudio\u0007-mac ", expect_rev: 1 });
  expect(r.rs.out).toMatchObject({ result: { name: "studio-mac", rev: 2 } });
  expect(exact(r.rs)).toEqual(exact(r.ts));

  for (const params of [
    { name: "late", expect_rev: 1 },
    { name: "\u200b\ufeff", expect_rev: 2 },
    { name: "x".repeat(257), expect_rev: 1.5 },
    { name: "", expect_rev: 0 },
    { name: [], expect_rev: {} },
    { name: "x", expect_rev: -1e300 },
    { name: "x", expect_rev: 2 ** 53 },
    { expect_rev: true },
    null,
    [],
  ]) {
    r = await both(home, "machine.set", params);
    expect(r.rs.out).toHaveProperty("error");
    expect(exact(r.rs)).toEqual(exact(r.ts));
  }
  for (const [op, params] of [["machine.get", { extra: 1 }], ["machine.get", null], ["machine.rotate", "x"], ["machine.rotate", [1]]] as const) {
    r = await both(home, op, params);
    expect(exact(r.rs)).toEqual(exact(r.ts));
  }

  r = await both(home, "machine.set", { name: "é".repeat(80), expect_rev: 2, extra: true });
  expect(r.rs.out).toMatchObject({ result: { rev: 3 } });
  expect(exact(r.rs)).toEqual(exact(r.ts));
});

test("native machine.get flags a copied home like TypeScript", async () => {
  const home = tmpDir(), copy = tmpDir();
  await typescript(home, "machine.get", {});
  rmSync(copy, { recursive: true, force: true });
  cpSync(join(home, "identity"), join(copy, "identity"), { recursive: true });
  const r = await both(copy, "machine.get", {});
  expect(r.rs.out).toMatchObject({ result: { cloneSuspected: true } });
  expect(exact(r.rs)).toEqual(exact(r.ts));
});

test("native machine.rotate matches TypeScript files, events and signature", async () => {
  const home = tmpDir();
  await typescript(home, "machine.get", {});
  const before = native(home, "machine.get", {}).result;
  const r = await both(home, "machine.rotate", {});
  expect(r.rs.out.result.oldId).toBe(before.id);
  expect(normalize(r.rs)).toEqual(normalize(r.ts));

  const view = native(home, "machine.get", {}).result;
  expect(view).toMatchObject({ id: r.rs.out.result.newId, rotatedFrom: before.id, rev: 2 });
  const payload = new TextEncoder().encode(`${before.id}\0${view.id}`);
  expect(verifyFrom(before.id, "pacer", "rotate", payload, Buffer.from(view.rotationSignature, "base64"))).toBe(true);
  expect(await typescript(home, "machine.get", {})).toEqual({ result: view });
});

test("an identity created natively loads unchanged in TypeScript", async () => {
  const home = tmpDir();
  const r = await both(home, "machine.get", {});
  expect(normalize(r.rs, true)).toEqual(normalize(r.ts, true));
  expect(readMeta(ctxFor(home))?.backend).toBe("file");
  expect(await typescript(home, "machine.get", {})).toEqual(r.rs.out);
});

for (const stop of ["pending", "staged", "swapped", "salted", "unstaged"] as RotationStep[]) {
  test(`native load recovers a rotation stopped after ${stop} like TypeScript`, async () => {
    const home = tmpDir();
    await typescript(home, "machine.get", {});
    clearIdentityCache();
    let newId = "";
    await expect(rotateIdentity(ctxFor(home), { platform: "linux", afterStep: (s, id) => { newId = id; if (s === stop) throw new Error("stop"); } })).rejects.toThrow("stop");
    const r = await both(home, "machine.get", {});
    const rolledBack = stop === "pending";
    expect(r.rs.out.result.id === newId).toBe(!rolledBack);
    expect(normalize(r.rs)).toEqual(normalize(r.ts));
    expect(await typescript(home, "machine.get", {})).toEqual(r.rs.out);
  });
}
