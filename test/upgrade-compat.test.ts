// test/upgrade-compat.test.ts
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ViewerHub } from "../src/session/viewers";
import { FrameType, WireDecoder, wire } from "../src/session/framing";
import { clientHello } from "../src/session/protocol";
import { socketFrameMessage, viewerMessageFrames } from "../src/serve/session-ws";
import { readRun } from "../src/supervisor/run";
import { Recording } from "../src/session/recording";
import { SessionClient } from "../app/src/term/client";
import { tmpDir } from "./helpers";

const VERSIONS = ["0.10.0", "0.11.0", "0.12.0"];
const fixture = (version: string, ...path: string[]) => join(import.meta.dir, "fixtures/upgrade", version, ...path);
const snapshot = () => wire(FrameType.snapshot, { outputOffset: 0, cols: 80, rows: 24, scrollbackAnsi: "", screenAnsi: "", controller: null, viewers: 1 });

class Peer extends EventEmitter {
  destroyed = false; writableLength = 0; frames: Buffer[] = [];
  constructor(private onFrame?: (bytes: Buffer) => void) { super(); }
  write(b: Buffer) { this.frames.push(b); this.onFrame?.(b); return true; }
  end(b: Buffer, cb?: () => void) { this.write(b); this.destroyed = true; cb?.(); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
/** Connect a browser SessionClient class to a host hub through the service relay's own codecs. */
async function attachApp(Client: typeof SessionClient, hub: { add(socket: never): void }) {
  const states: { status: string; message?: string }[] = [];
  let socket: { onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null } | undefined;
  const peer = new Peer(bytes => { for (const frame of new WireDecoder().push(bytes)) socket?.onmessage?.({ data: socketFrameMessage(frame) }); });
  hub.add(peer as never);
  const client = new Client({ url: "ws://fixture", label: "fixture", cols: 80, rows: 24, control: true, onState: s => states.push(s), socket: () => {
    socket = { readyState: 1, binaryType: "", onopen: null, onclose: null, onerror: null, onmessage: null, close() {},
      send(data: string | Uint8Array) { for (const bytes of viewerMessageFrames(typeof data === "string" ? data : Buffer.from(data))) peer.emit("data", bytes); } } as never;
    return socket as never;
  } });
  client.connect();
  socket!.onopen?.();
  await Bun.sleep(0);
  return states;
}

for (const version of VERSIONS) {
  test(`${version} web app attaches to a new host and never sees a new frame type`, async () => {
    const { SessionClient: Old } = await import(fixture(version, "term-client.ts"));
    const hub = new ViewerHub(snapshot, () => null, fn => fn(), () => {}, () => {}, undefined, { pacer: "0.13.1", versions: [1, 1] });
    const states = await attachApp(Old, hub);
    expect(states.some(s => s.status === "live")).toBe(true);
    expect(states.some(s => s.status === "error")).toBe(false);
  });

  test(`${version} CLI hello attaches to a new host`, () => {
    const hub = new ViewerHub(snapshot, () => null, fn => fn(), () => {}, () => {}, undefined, { pacer: "0.13.1", versions: [1, 1] });
    const peer = new Peer(); hub.add(peer as never);
    peer.emit("data", wire(FrameType.hello, { v: 1, client: "cli", label: "xterm", cols: 80, rows: 24 }));
    const frames = peer.frames.flatMap(b => new WireDecoder().push(b));
    expect(frames.map(f => f.type)).toEqual([FrameType.snapshot, FrameType.control]);
    expect(JSON.parse(frames[1].data.toString()).versions).toBeUndefined();
  });

  test(`${version} host accepts a new client and its silence means v1`, async () => {
    const { ViewerHub: OldHub } = await import(fixture(version, "viewers.ts"));
    const oldHub = new OldHub(snapshot, () => null, (fn: () => void) => fn());
    const states = await attachApp(SessionClient, oldHub);
    expect(states.some(s => s.status === "live")).toBe(true);
    const peer = new Peer(); oldHub.add(peer as never);
    peer.emit("data", wire(FrameType.hello, { v: 1, client: "cli", label: "x", cols: 80, rows: 24, ...clientHello() }));
    const control = peer.frames.flatMap(b => new WireDecoder().push(b)).find(f => f.type === FrameType.control)!;
    expect(JSON.parse(control.data.toString()).versions).toBeUndefined();
  });

  test(`${version} recording reader decodes a new host's session log`, async () => {
    const { decodeLog } = await import(fixture(version, "framing.ts"));
    const dir = tmpDir(), recording = new Recording(dir);
    await recording.output(Buffer.from("hello from a new host\n"));
    await recording.close();
    const log = decodeLog(readFileSync(join(dir, "session.log")));
    expect(log.frames.some((f: { data: Buffer }) => f.data.toString().includes("hello from a new host"))).toBe(true);
  });

  test(`${version} run directories stay readable and session.host keeps its exact value`, () => {
    const headless = tmpDir(); cpSync(fixture(version, "run-headless"), headless, { recursive: true });
    expect(readRun(headless)).toMatchObject({ exit: 0, alive: false });
    expect(readFileSync(join(headless, "stdout"), "utf8")).toContain("fixture-output");
    expect(readFileSync(fixture(version, "run-interactive", "session.host"), "utf8")).toBe("builtin");
    expect(existsSync(fixture(version, "run-interactive", "session.version"))).toBe(false);
  });

  test(`${version} task record and its sweep result`, () => {
    const record = JSON.parse(readFileSync(fixture(version, "task-running.json"), "utf8"));
    expect(record).toMatchObject({ state: "running", run: { attempt: 1, executor: "codex" } });
    expect(JSON.parse(readFileSync(fixture(version, "rollback-sweep.json"), "utf8"))).toEqual({ spawned: 1, state: "running", handoverKept: true });
  });
}
