import { expect, test } from "bun:test";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { installFixture } from "../conformance/install";
import { tmpDir } from "./helpers";

const front = process.env.PACER_TEST_FRONT_DOOR;
const context = { route: "overview", theme: "light" };

test.skipIf(!front)("native raw JSON decoding matches fetch and JSON.parse boundaries", async () => {
  const results: unknown[][] = [];
  for (const forward of ["", "*"]) {
    const s = await service(forward), responses: unknown[] = [];
    try {
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      const raw = async (op: string, body: Uint8Array | string) => {
        const response = await fetch(`${s.base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: typeof body === "string" ? body : new Uint8Array(body), signal: AbortSignal.timeout(15000) });
        return response.json() as Promise<any>;
      };
      for (const wire of ["1e309", "-1e309", "1e400", "-1e400"]) {
        const rev = await raw("plugin.settings.set", `{"plugin":"fx-ui","values":{},"expect_rev":${wire}}`);
        expect(rev.error.code).toBe("invalid_input");
        expect(rev.error.message).not.toBe("body is not JSON");
        responses.push(rev);
        const value = await raw("plugin.settings.set", `{"plugin":"fx-ui","values":{"required":${wire}},"expect_rev":0}`);
        expect(value.error.code).toBe("invalid_input");
        responses.push(value);
      }
      const get = '{"plugin":"fx-ui"}';
      responses.push(await raw("plugin.settings.get", Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(get)])));
      const badUtf8 = Buffer.from('{"plugin":"fx-ui","values":{"items":["X"]},"expect_rev":0}');
      badUtf8[badUtf8.indexOf("X")] = 255;
      expect(await raw("plugin.settings.set", badUtf8)).toMatchObject({ result: { rev: 1 } });
      responses.push(await s.post("plugin.settings.get", { plugin: "fx-ui" }));
      writeFileSync(join(s.state, "plugin-settings.json"), Buffer.concat([Buffer.from('{"fx-ui":{"rev":3,"values":{"items":["'), Buffer.from([255]), Buffer.from('"]}}}') ]));
      const stored = await s.post("plugin.settings.get", { plugin: "fx-ui" });
      expect(stored.result).toMatchObject({ rev: 3, values: { items: ["�"] } });
      responses.push(stored);
      writeFileSync(join(s.state, "plugin-settings.json"), '{"fx-ui":{"rev":1e400,"values":{"required":true}},"other":{"rev":3,"values":{"kept":true}}}');
      expect((await s.post("plugin.settings.get", { plugin: "fx-ui" })).result).toMatchObject({ rev: null, values: { required: true } });
      expect(readFileSync(join(s.state, "plugin-settings.json"), "utf8")).toContain('"other"');
      responses.push(await s.post("plugin.settings.set", { plugin: "fx-ui", values: {}, expect_rev: 0 }));
    } finally { await s.stop(); }
    results.push(responses);
  }
  expect(results[0]).toEqual(results[1]);
}, 60000);

async function service(forward = "", homeKind = "absolute") {
  const home = realpathSync(tmpDir()), state = join(home, ".pacer");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n# preserve this comment\n", { mode: 0o600 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  const plugin = installFixture("ui", join(state, "plugins"));
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = socket.port!; socket.stop(true);
  let configuredHome = state;
  if (homeKind.includes("symlink")) {
    configuredHome = join(home, "linked");
    symlinkSync(".pacer", configuredHome, "dir");
  }
  if (homeKind.includes("relative")) configuredHome = relative(process.cwd(), configuredHome);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], {
    env: { HOME: home, PACER_HOME: configuredHome, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", PACER_FORWARD_OPS: forward },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const logs = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  try {
    for (let i = 0; i < 500; i++) {
      try {
        token = readFileSync(join(state, "token"), "utf8").trim();
        const response = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch { /* Wait for this owned child only. */ }
      if (child.exitCode !== null) throw Error(await logs);
      await Bun.sleep(20);
    }
    if (!token) throw Error("native fixture did not become ready");
  } catch (error) { child.kill("SIGTERM"); await child.exited; throw error; }
  const post = async (op: string, params: unknown) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
    return await response.json() as any;
  };
  return { home, state, plugin, base, token, post, async stop() {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    return logs;
  } };
}

test.skipIf(!front)("the whole public plugin operation set matches forced TypeScript fallback", async () => {
  const results: unknown[][] = [];
  for (const forward of ["", "*"]) {
    const s = await service(forward), actual: unknown[] = [];
    try {
      const fx = async () => (await s.post("plugin.list", {})).result.plugins.find((p: any) => p.id === "fx-ui");
      actual.push((await fx()).state);
      actual.push(await s.post("plugin.enable", { id: "fx-ui" }));
      const enabled = await s.post("plugin.enable", { id: "fx-ui", grant: true });
      expect(enabled, JSON.stringify(enabled)).toEqual({ result: { id: "fx-ui", state: "idle" } });
      actual.push(enabled);
      actual.push(await s.post("plugin.ui.list", {}));
      for (const op of ["plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility"]) {
        actual.push(await s.post(op, { plugin: "fx-ui", surface: "activity", id: "missing", context, action: "run", requestId: "r", visible: false, expect_rev: 0 }));
      }
      expect((await fx()).pid).toBeNull();
      actual.push(await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context }));
      expect((await fx()).pid).toBeNull();
      actual.push(await s.post("plugin.settings.get", { plugin: "fx-ui" }));
      actual.push(await s.post("plugin.settings.set", { plugin: "fx-ui", values: { required: "yes", nope: 1 }, expect_rev: 0 }));
      const save = { plugin: "fx-ui", values: { required: true, items: ["a", "b"] }, expect_rev: 0 };
      actual.push(await s.post("plugin.settings.set", save));
      actual.push(await s.post("plugin.settings.set", save));
      const visibility = { plugin: "fx-ui", surface: "activity", id: "checklist", visible: false, expect_rev: 1 };
      actual.push(await s.post("plugin.ui.visibility", visibility));
      actual.push(await s.post("plugin.ui.visibility", visibility));
      const render = await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
      expect(render.error, JSON.stringify(render)).toBeUndefined();
      actual.push({ ...render.result, renderedAt: 0 });
      const statusParams = { plugin: "fx-ui", surface: "status", id: "open-items", context };
      const status = await s.post("plugin.ui.render", statusParams);
      expect(status.error, JSON.stringify(status)).toBeUndefined();
      expect(status.result.ttlS).toBe(30);
      expect(await s.post("plugin.ui.render", statusParams)).toEqual(status);
      actual.push(await s.post("plugin.ui.action", { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "run", requestId: "r1" }));
      const doctor = await s.post("plugin.doctor", { id: "fx-ui" });
      expect(doctor.error).toBeUndefined();
      actual.push({ ...doctor.result.reports[0], pid: 0 });
      writeFileSync(join(s.plugin, "fixture.json"), JSON.stringify({ validateErrors: [{ path: "items", message: "too vague" }] }));
      // The process retains its startup fixture; native and fallback must do so too.
      actual.push(await s.post("plugin.settings.set", { plugin: "fx-ui", values: { items: ["x"] }, expect_rev: 2 }));
      actual.push(await s.post("plugin.disable", { id: "fx-ui" }));
      actual.push(await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context }));
      actual.push(await s.post("plugin.remove", { id: "fx-ui" }));
      actual.push(await s.post("plugin.enable", { id: "fx-ui" }));
      actual.push(await s.post("plugin.install", {}));
      for (const params of [null, [], { plugin: "Bad" }, { plugin: "fx-ui", values: {}, expect_rev: 1.5 }]) actual.push(await s.post("plugin.settings.set", params));
      expect(readFileSync(join(s.state, "strategy.yaml"), "utf8")).toContain("# preserve this comment");
      expect((await fetch(`${s.base}/_internal/plugins`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: "{}" })).status).toBe(404);
      results.push(actual);
    } finally {
      const log = await s.stop();
      if (!forward && results.length > 0) for (const op of ["plugin.list", "plugin.enable", "plugin.disable", "plugin.remove", "plugin.doctor", "plugin.ui.list", "plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility", "plugin.settings.get", "plugin.settings.set", "plugin.install"]) expect(log).toContain(`native ${op}`);
      else if (forward) expect(log).not.toMatch(/^native plugin\./m);
    }
  }
  expect(results[0]).toEqual(results[1]);
}, 90000);

test.skipIf(!front)("native settings CAS, ready-plugin veto and private modes", async () => {
  const s = await service();
  const lockMode = existsSync(join(s.state, "orca")) ? statSync(join(s.state, "orca")).mode & 0o777 : 0o700;
  try {
    writeFileSync(join(s.plugin, "fixture.json"), JSON.stringify({ validateErrors: [{ path: "items", message: "too vague" }] }));
    const enabled = await s.post("plugin.enable", { id: "fx-ui", grant: true });
    expect(enabled, JSON.stringify(enabled)).toEqual({ result: { id: "fx-ui", state: "idle" } });
    const writes = await Promise.all([true, false].map(required => s.post("plugin.settings.set", { plugin: "fx-ui", values: { required }, expect_rev: 0 })));
    expect(writes.filter(w => w.result?.rev === 1), JSON.stringify(writes)).toHaveLength(1);
    expect(writes.filter(w => w.error?.code === "conflict")).toHaveLength(1);
    await s.post("plugin.doctor", { id: "fx-ui" });
    const veto = await s.post("plugin.settings.set", { plugin: "fx-ui", values: { items: ["x"] }, expect_rev: 1 });
    expect(veto.error).toMatchObject({ code: "invalid_input", data: { errors: [{ path: "items", message: "too vague" }] } });
    expect((await s.post("plugin.settings.get", { plugin: "fx-ui" })).result.rev).toBe(1);
    const { statSync } = await import("node:fs");
    for (const file of ["strategy.yaml", "plugin-settings.json"]) expect(statSync(join(s.state, file)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.state, "orca")).mode & 0o777).toBe(lockMode);
  } finally { await s.stop(); }
}, 45000);

test.skipIf(!front)("native and individually forwarded UI operations share targeted invalidation", async () => {
  for (const forward of ["plugin.ui.action", "plugin.ui.render"]) {
    const s = await service(forward);
    try {
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      await s.post("plugin.doctor", { id: "fx-ui" });
      const status = { plugin: "fx-ui", surface: "status", id: "open-items", context };
      const before = await s.post("plugin.ui.render", status);
      expect(before.error, JSON.stringify(before)).toBeUndefined();
      const activity = { plugin: "fx-ui", surface: "activity", id: "checklist", context };
      await s.post("plugin.ui.action", { ...activity, action: "run", requestId: "activity" });
      expect(await s.post("plugin.ui.render", status)).toEqual(before);
      await s.post("plugin.ui.action", { ...status, action: "run", requestId: "status" });
      const after = await s.post("plugin.ui.render", status);
      expect(after.error, JSON.stringify(after)).toBeUndefined();
      expect(after.result.document.text).not.toBe(before.result.document.text);
    } finally { await s.stop(); }
  }
}, 45000);

// A release file controls the response; this tests admission, not plugin timeout speed.
test.skipIf(!front)("pending actions leave independent plugin requests available", async () => {
  for (const forward of ["", "*"]) {
    const s = await service(forward);
    const started = join(s.home, "started"), release = join(s.home, "release");
    let pending: Promise<any> | undefined;
    try {
      writeFileSync(join(s.plugin, "main.ts"), `#!/usr/bin/env bun
import {serve,stdinLines} from '@pacer/plugin';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./pacer-plugin.json',import.meta.url),'utf8'));
await serve({manifest,input:stdinLines(),handlers:{'ui.action':async p=>{
 if(p.action==='hold'){writeFileSync(${JSON.stringify(started)},'started');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);}
 return {result:'done'};
}}});`);
      const other = join(s.state, "plugins/fx-other"); cpSync(s.plugin, other, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(other, "pacer-plugin.json"), "utf8"));
      manifest.id = "fx-other"; writeFileSync(join(other, "pacer-plugin.json"), JSON.stringify(manifest));
      for (const id of ["fx-ui", "fx-other"]) expect((await s.post("plugin.enable", { id, grant: true })).error).toBeUndefined();
      const action = { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "hold", requestId: "hold" };
      pending = s.post("plugin.ui.action", action);
      for (let i = 0; i < 500 && !existsSync(started); i++) await Bun.sleep(10);
      expect(existsSync(started), JSON.stringify(await Promise.race([pending, Bun.sleep(1).then(() => "pending")]))).toBe(true);
      const independent = Promise.all([
        s.post("plugin.list", {}), s.post("plugin.ui.list", {}),
        s.post("plugin.settings.get", { plugin: "fx-ui" }),
        s.post("plugin.ui.action", { ...action, action: "quick", id: "checklist-tab", surface: "panelTab", requestId: "other-surface" }),
        s.post("plugin.ui.action", { ...action, plugin: "fx-other", action: "quick", requestId: "other-plugin" }),
      ]);
      const outcome = await Promise.race([independent, Bun.sleep(1500).then(() => "blocked")]);
      expect(outcome).not.toBe("blocked");
      for (const response of outcome as any[]) expect(response.error).toBeUndefined();
      expect((await s.post("plugin.ui.action", action)).error?.code).toBe("conflict");
    } finally {
      writeFileSync(release, "release"); await pending; await s.stop();
    }
  }
}, 60000);

test.skipIf(!front)("linked settings reads and atomic replacement match TypeScript", async () => {
  for (const kind of ["symlink", "hardlink"]) {
    const results: unknown[] = [];
    for (const forward of ["", "*"]) {
      const s = await service(forward);
      try {
        await s.post("plugin.enable", { id: "fx-ui", grant: true });
        const target = join(s.home, "settings-target.json"), name = join(s.state, "plugin-settings.json");
        const text = JSON.stringify({ "fx-ui": { rev: 7, values: { required: true }, hidden: ["activity:checklist"] } });
        writeFileSync(target, text, { mode: 0o600 });
        if (kind === "symlink") symlinkSync(target, name); else linkSync(target, name);
        const get = await s.post("plugin.settings.get", { plugin: "fx-ui" });
        expect(get.result?.rev, JSON.stringify(get)).toBe(7);
        results.push(get, await s.post("plugin.ui.list", {}));
        const save = await s.post("plugin.settings.set", { plugin: "fx-ui", values: { required: false }, expect_rev: 7 });
        expect(save.result?.rev).toBe(8); results.push(save);
        expect(readFileSync(target, "utf8")).toBe(text);
      } finally { await s.stop(); }
    }
    expect(results.slice(0, 3)).toEqual(results.slice(3));
  }
}, 60000);


test.skipIf(!front)("configured symlinked and relative homes match TypeScript settings writes", async () => {
  for (const kind of ["symlink", "relative", "relative-symlink"]) {
    const results: unknown[][] = [];
    for (const forward of ["", "*"]) {
      const s = await service(forward, kind), actual: unknown[] = [];
      try {
        const enable = await s.post("plugin.enable", { id: "fx-ui", grant: true });
        expect(enable.result?.state, JSON.stringify(enable)).toBe("idle"); actual.push(enable);
        const save = await s.post("plugin.settings.set", { plugin: "fx-ui", values: { required: true }, expect_rev: 0 });
        expect(save.result?.rev, JSON.stringify(save)).toBe(1); actual.push(save);
        const hidden = await s.post("plugin.ui.visibility", { plugin: "fx-ui", surface: "activity", id: "checklist", visible: false, expect_rev: 1 });
        expect(hidden.result?.rev, JSON.stringify(hidden)).toBe(2); actual.push(hidden);
        actual.push(await s.post("plugin.settings.get", { plugin: "fx-ui" }));
        const remove = await s.post("plugin.remove", { id: "fx-ui" });
        expect(remove.result?.removed, JSON.stringify(remove)).toBe(true); actual.push(remove);
        expect(JSON.parse(readFileSync(join(s.state, "plugin-settings.json"), "utf8"))["fx-ui"]).toBeUndefined();
        results.push(actual);
      } finally { await s.stop(); }
    }
    expect(results[0], kind).toEqual(results[1]);
  }
}, 60000);

test.skipIf(!front)("lone UTF-16 units survive request, IPC, settings store and render", async () => {
  const results: unknown[][] = [];
  for (const forward of ["", "*"]) {
    const s = await service(forward);
    try {
      const manifest = JSON.parse(readFileSync(join(s.plugin, "pacer-plugin.json"), "utf8"));
      manifest.contributes.ui.settings[0].schema.fields.text = { type: "string", title: "Text" };
      writeFileSync(join(s.plugin, "pacer-plugin.json"), JSON.stringify(manifest));
      writeFileSync(join(s.plugin, "fixture.json"), JSON.stringify({ uiDocument: { type: "text", text: "a\ud800b﷐" } }));
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      const values = { text: "a\ud800b﷐", items: ["\udfff", "𐏿"] };
      const saved = await s.post("plugin.settings.set", { plugin: "fx-ui", values, expect_rev: 0 });
      expect(saved.result?.values).toEqual(values);
      const bytes = readFileSync(join(s.state, "plugin-settings.json"), "utf8");
      expect(JSON.parse(bytes)["fx-ui"].values).toEqual(values);
      const rendered = await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
      expect(rendered.result?.document).toEqual({ type: "text", text: "a\ud800b﷐" });
      await Bun.sleep(1100);
      const response = await fetch(`${s.base}/v3/ops/plugin.ui.render`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ plugin: "fx-ui", surface: "activity", id: "checklist", context }) });
      const wire = await response.text();
      expect(wire).toBe(JSON.stringify(JSON.parse(wire)));
      expect(wire).toMatch(/"renderedAt":\d+,"ttlS":0/);
      results.push([saved, await s.post("plugin.settings.get", { plugin: "fx-ui" }), rendered.result?.document, bytes]);
    } finally { await s.stop(); }
  }
  expect(results[0]).toEqual(results[1]);
}, 60000);

test.skipIf(!front)("deep render returns the document error and cannot serve stale cache", async () => {
  const outcomes: unknown[] = [];
  for (const forward of ["", "*"]) {
    const s = await service(forward);
    try {
      // Return a cacheable valid response, then a deep document on a different
      // context (same surface) after the TTL. The file is read per request.
      writeFileSync(join(s.plugin, "main.ts"), `#!/usr/bin/env bun
import {serve,stdinLines} from '@pacer/plugin';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('pacer-plugin.json','utf8'));
let n=0;await serve({manifest,input:stdinLines(),handlers:{'ui.render':async()=>{let document={type:'text',text:'valid'};if(++n>1)for(let i=0;i<70;i++)document={type:'stack',gap:'related',children:[document]};return {document,ttlS:-0}}}});`);
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      const params = { plugin: "fx-ui", surface: "activity", id: "checklist", context };
      const response = await fetch(`${s.base}/v3/ops/plugin.ui.render`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: JSON.stringify(params) });
      const bytes = await response.text();
      expect(bytes).toBe(JSON.stringify(JSON.parse(bytes)));
      expect(bytes).toMatch(/"renderedAt":\d+,"ttlS":0/);
      expect(JSON.parse(bytes).result?.document.text).toBe("valid");
      await Bun.sleep(30);
      const result = await s.post("plugin.ui.render", params);
      expect(result).toEqual({ error: { code: "invalid_input", message: "This plugin's view couldn't be shown" } });
      outcomes.push(result);
    } finally { await s.stop(); }
  }
  expect(outcomes[0]).toEqual(outcomes[1]);
}, 60000);

test.skipIf(!front)("disconnect during disable still completes refresh and config publication", async () => {
  const { createConnection } = await import("node:net");
  for (const forward of ["", "*"]) {
    const s = await service(forward);
    try {
      writeFileSync(join(s.plugin, "main.ts"), `#!/usr/bin/env bun
import {serve,stdinLines} from '@pacer/plugin';import {readFileSync,writeFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('pacer-plugin.json','utf8'));
process.on('SIGTERM',()=>{writeFileSync('stopping','yes');setTimeout(()=>process.exit(0),1200)});
await serve({manifest,input:stdinLines(),handlers:{'ui.render':async()=>({document:{type:'text',text:'ready'},ttlS:0})}});`);
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
      const snapshot = await (await fetch(`${s.base}/v3/snapshot`, { headers: { Authorization: `Bearer ${s.token}` } })).json() as any;
      const eventsAbort = new AbortController();
      const events = await fetch(`${s.base}/v3/events?since=${snapshot.seq}` , { headers: { Authorization: `Bearer ${s.token}` }, signal: eventsAbort.signal });
      expect(events.ok).toBe(true);
      let published = false;
      const reading = (async () => { const reader = events.body!.getReader(); let text = ""; try { for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); if (/event: config/.test(text)) { published = true; break; } } } catch {} finally { await reader.cancel().catch(() => {}); } })();
      const url = new URL(s.base), body = JSON.stringify({ id: "fx-ui" });
      const socket = createConnection(Number(url.port), "127.0.0.1");
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.write(`POST /v3/ops/plugin.disable HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${s.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      try {
        for (let i = 0; i < 300 && !existsSync(join(s.plugin, "stopping")); i++) await Bun.sleep(10);
        expect(existsSync(join(s.plugin, "stopping"))).toBe(true);
      } finally { socket.destroy(); }
      try {
        for (let i = 0; i < 400 && !published; i++) await Bun.sleep(10);
        expect(published).toBe(true);
        const entry = (await s.post("plugin.list", {})).result.plugins.find((p: any) => p.id === "fx-ui");
        expect(entry.state).toBe("disabled"); expect(entry.pid).toBeNull();
        expect(readFileSync(join(s.state, "strategy.yaml"), "utf8")).toContain("fx-ui");
      } finally { eventsAbort.abort(); await reading; }
    } finally { await s.stop(); }
  }
}, 60000);

test.skipIf(!front)("filesystem and strategy edit errors retain TypeScript codes and messages", async () => {
  const { renameSync, unlinkSync } = await import("node:fs");
  const results: unknown[][] = [];
  for (const forward of ["", "*"]) {
    const s = await service(forward);
    try {
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      const dir = join(s.state, "orca"); renameSync(dir, `${dir}-original`); writeFileSync(dir, "not a directory");
      const lock = await s.post("plugin.settings.set", { plugin: "fx-ui", values: {}, expect_rev: 0 });
      expect(lock.error).toEqual({ code: "internal", message: `EEXIST: file already exists, mkdir '${dir}'` });
      unlinkSync(dir); renameSync(`${dir}-original`, dir);
      // Snapshot still discovers the plugin, but editStrategy cannot read its
      // now-missing strategy. This is invalid_input, not plugin_refused.
      unlinkSync(join(s.state, "strategy.yaml"));
      const edit = await s.post("plugin.disable", { id: "fx-ui" });
      expect(edit.error).toEqual({ code: "invalid_input", message: `ENOENT: no such file or directory, open '${join(s.state, "strategy.yaml")}'` });
      results.push([lock.error.code, edit.error.code]);
    } finally { await s.stop(); }
  }
  expect(results[0]).toEqual(results[1]);
}, 60000);

test.skipIf(!front)("lock timeout names configured home rather than its canonical target", async () => {
  for (const forward of ["", "*"]) {
    const s = await service(forward, "symlink");
    try {
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      writeFileSync(join(s.state, "orca/plugin-settings.lock"), "", { mode: 0o600 });
      const response = await fetch(`${s.base}/v3/ops/plugin.settings.set`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ plugin: "fx-ui", values: {}, expect_rev: 0 }), signal: AbortSignal.timeout(25000) });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal", message: `timed out waiting for ${join(s.home, "linked/orca/plugin-settings.lock")}` } });
    } finally { await s.stop(); }
  }
}, 60000);

test.skipIf(!front)("lone-surrogate action lengths use Zod code-point limits", async () => {
  for (const forward of ["", "*"]) {
    const s = await service(forward);
    try {
      writeFileSync(join(s.plugin, "fixture.json"), JSON.stringify({ actionMessage: "\ud800".repeat(200) }));
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      const action = { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "run", requestId: "\ud800".repeat(128), values: { ["\udfff".repeat(64)]: "\ud800".repeat(2000) } };
      const response = await s.post("plugin.ui.action", action);
      expect(response).toEqual({ result: { result: "refresh", message: "\ud800".repeat(200) } });
      expect((await s.post("plugin.ui.action", { ...action, requestId: action.requestId + "x" })).error?.code).toBe("invalid_input");
    } finally { await s.stop(); }
  }
}, 60000);
