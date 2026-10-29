import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostSupported, hostOlder, hostVersionView, negotiate, parseVersions, readSessionVersion, SESSION_PROTOCOL, writeSessionVersion } from "../src/session/protocol";
import { ViewerHub } from "../src/session/viewers";
import { FrameType, WireDecoder, wire } from "../src/session/framing";
import { socketFrameMessage, viewerMessageFrames } from "../src/serve/session-ws";
import { startRun } from "../src/supervisor/run";
import { pruneTaskSessions } from "../src/session/retention";
import { SCRIPTS } from "../src/remote/scripts";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

class Peer extends EventEmitter {
  destroyed = false; writableLength = 0; frames: Buffer[] = [];
  write(b: Buffer) { this.frames.push(b); return true; }
  end(b: Buffer, cb?: () => void) { this.write(b); this.destroyed = true; cb?.(); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
const decoded = (p: Peer) => p.frames.flatMap(b => new WireDecoder().push(b));
const controls = (p: Peer) => decoded(p).filter(f => f.type === FrameType.control).map(f => JSON.parse(f.data.toString()));
const hub = () => new ViewerHub(() => wire(FrameType.snapshot, { outputOffset: 0 }), () => null, fn => fn(), () => {}, () => {}, undefined, { pacer: "0.13.1", versions: [1, 1] });

test("negotiation picks the highest shared version and treats a missing range as v1", () => {
  expect(negotiate(null)).toBe(1);
  expect(negotiate([1, 1])).toBe(1);
  expect(negotiate([2, 3], [1, 1])).toBeNull();
  expect(negotiate([1, 3], [1, 2])).toBe(2);
  expect(parseVersions([1, 2])).toEqual([1, 2]);
  for (const bad of [[2, 1], [0, 1], [1], "1", [1.5, 2], null]) expect(parseVersions(bad)).toBeNull();
  expect(SESSION_PROTOCOL).toEqual([1, 1]);
});

test("the support window covers the last three minors and hosts without session.version", () => {
  expect(hostSupported(null, "0.12.0")).toBe(true);
  expect(hostSupported({ pacer: "0.9.4", versions: [1, 1] }, "0.12.0")).toBe(true);
  expect(hostSupported({ pacer: "0.8.0", versions: [1, 1] }, "0.12.0")).toBe(false);
  expect(hostSupported({ pacer: "0.12.0", versions: [2, 2] }, "0.12.0")).toBe(false);
  expect(hostOlder(null, "0.12.0")).toBe(true);
  expect(hostOlder({ pacer: "0.12.0", versions: [1, 1] }, "0.12.0")).toBe(false);
  expect(hostOlder({ pacer: "0.11.3", versions: [1, 1] }, "0.12.0")).toBe(true);
});

test("session.version is owner-only, renamed into place and read strictly", () => {
  const dir = tmpDir();
  writeSessionVersion(dir, { pid: 42, bootId: "b", birth: "1" });
  expect(statSync(join(dir, "session.version")).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(["session.version"]);
  expect(readSessionVersion(dir)).toMatchObject({ versions: [1, 1], identity: { pid: 42 } });
  writeFileSync(join(dir, "session.version"), "{\"pacer\":1}");
  expect(readSessionVersion(dir)).toBeNull();
  expect(hostVersionView(dir, "0.12.0")).toEqual({ pacer: null, older: true, supported: true });
  writeFileSync(join(dir, "session.version"), JSON.stringify({ pacer: "0.1.0\u001b[2J", versions: [1, 1] }));
  expect(readSessionVersion(dir)).toBeNull();
});

test("a host replies with its range only on the first control frame of a client that sent versions", () => {
  const h = hub(), modern = new Peer(), legacy = new Peer();
  h.add(modern as never); h.add(legacy as never);
  modern.emit("data", wire(FrameType.hello, { v: 1, versions: [1, 1], pacer: "0.13.1" }));
  legacy.emit("data", wire(FrameType.hello, { v: 1 }));
  expect(controls(modern)[0]).toMatchObject({ versions: [1, 1], pacer: "0.13.1" });
  expect(controls(legacy)[0].versions).toBeUndefined();
  modern.emit("data", wire(FrameType.take, {}));
  expect(controls(modern).at(-1).versions).toBeUndefined();
  for (const p of [modern, legacy]) expect(decoded(p).every(f => [FrameType.snapshot, FrameType.control, FrameType.output, FrameType.resize, FrameType.resync, FrameType.exit].includes(f.type as never))).toBe(true);
});

test("malformed versions are refused and a client outside the window is told to reopen", () => {
  const h = hub(), bad = new Peer(), future = new Peer();
  h.add(bad as never); h.add(future as never);
  bad.emit("data", wire(FrameType.hello, { v: 1, versions: [3, 1] }));
  expect(bad.destroyed).toBe(true);
  future.emit("data", wire(FrameType.hello, { v: 1, versions: [2, 3] }));
  const exit = decoded(future).find(f => f.type === FrameType.exit)!;
  expect(JSON.parse(exit.data.toString()).reason).toContain("Reopen to update");
  expect(h.size).toBe(0);
});

test("the service relay keeps hello versions and passes the control reply through", () => {
  const [hello] = viewerMessageFrames(JSON.stringify({ type: "hello", v: 1, versions: [1, 1], pacer: "0.13.1" }));
  expect(JSON.parse(new WireDecoder().push(hello)[0].data.toString())).toMatchObject({ v: 1, versions: [1, 1], client: "app" });
  const message = socketFrameMessage({ type: FrameType.control, data: Buffer.from(JSON.stringify({ controller: null, you: false, versions: [1, 1], pacer: "0.13.1" })) });
  expect(JSON.parse(message as string)).toMatchObject({ type: "control", versions: [1, 1] });
});

test("session.version is reset with a reused run directory, pruned with sessions and cleaned remotely", async () => {
  const ctx = fakeCtx(), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const dir = join(ctx.pacerHome, "runs", t.id, "1");
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "session.version"), "stale");
  startRun({ dir, argv: ["true"], cwd: repo, env: { PATH: process.env.PATH } });
  expect(existsSync(join(dir, "session.version"))).toBe(false);
  writeFileSync(join(dir, "session.version"), "{}");
  pruneTaskSessions(ctx, updateTask(ctx, t.id, x => { x.state = "done"; }));
  expect(existsSync(join(dir, "session.version"))).toBe(false);
  expect(SCRIPTS.START).toContain('"$D/session.version"');
  expect(readFileSync(join(import.meta.dir, "../app/src/term/client.ts"), "utf8")).toContain("versions:[1,1]");
});
