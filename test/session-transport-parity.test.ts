import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { FrameType, WireDecoder, wire } from "../src/session/framing";
import { ViewerHub } from "../src/session/viewers";

// These are TypeScript reference observations for the future native session host.
class Peer extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  frames: Buffer[] = [];
  write(bytes: Buffer) {
    this.frames.push(bytes);
    return true;
  }
  end(bytes: Buffer, done?: () => void) {
    this.write(bytes);
    this.destroyed = true;
    done?.();
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
  send(type: number, body: unknown) {
    this.emit("data", wire(type, body));
  }
  messages() {
    return new WireDecoder()
      .push(Buffer.concat(this.frames))
      .map((f) => ({ type: f.type, body: JSON.parse(f.data.toString()) }));
  }
}
function makeHub(actions: unknown[] = []) {
  return new ViewerHub(
    () => wire(FrameType.snapshot, { screen: "initial" }),
    () => null,
    (fn) => fn(),
    (kind, label) => actions.push([kind, label]),
    () => {},
    {
      input: (bytes) => actions.push(["input", bytes.toString()]),
      resize: (cols, rows) => actions.push(["resize", cols, rows]),
      release: (label) => actions.push(["release", label]),
    },
    { pacer: "1.2.3", versions: [1, 1] },
  );
}
function join(hub: ViewerHub, label: string) {
  const peer = new Peer();
  hub.add(peer as any);
  peer.send(FrameType.hello, { v: 1, label });
  return peer;
}

test("controller arbitration, forced takeover and explicit handback have stable wire results", () => {
  const actions: unknown[] = [],
    hub = makeHub(actions),
    a = join(hub, "one"),
    b = join(hub, "two");
  a.send(FrameType.take, {});
  b.send(FrameType.take, {});
  expect(b.messages().at(-1)).toEqual({
    type: 5,
    body: { controller: "cli:one", you: false, reason: "refused" },
  });
  b.send(FrameType.input, Buffer.from("ignored"));
  b.send(FrameType.take, { force: true });
  b.send(FrameType.input, Buffer.from("accepted"));
  a.send(FrameType.release, {});
  b.send(FrameType.release, {});
  expect(hub.controller).toBeNull();
  expect(actions).toEqual([
    ["attach", "cli:one"],
    ["attach", "cli:two"],
    ["control-taken", "cli:one"],
    ["control-released", "cli:one"],
    ["control-taken", "cli:two"],
    ["input", "accepted"],
    ["control-released", "cli:two"],
    ["release", "cli:two"],
  ]);
  expect(a.messages().slice(-2)).toEqual([
    { type: 5, body: { controller: "cli:two", you: false, reason: "taken" } },
    { type: 5, body: { controller: null, you: false, reason: "released" } },
  ]);
});

test.each([
  [0, true],
  [2, true],
  [Number.MAX_SAFE_INTEGER, true],
  [-1, false],
  [1.5, false],
  [Number.MAX_SAFE_INTEGER + 1, false],
  ["2", false],
  [null, false],
])("hello offset %p admission is %p", (from, admitted) => {
  const hub = makeHub(),
    peer = new Peer();
  hub.add(peer as any);
  peer.send(FrameType.hello, { v: 1, from });
  expect(hub.size).toBe(admitted ? 1 : 0);
  expect(peer.destroyed).toBe(!admitted);
});

test.each([
  [1, 1, true],
  [1000, 500, true],
  [1001, 500, false],
  [1000, 501, false],
  [0, 1, false],
  [1.5, 1, false],
  ["1", 1, false],
  [1e2, 1.0, true],
])("controller resize %p by %p accepted: %p", (cols, rows, accepted) => {
  const actions: unknown[] = [],
    hub = makeHub(actions),
    peer = join(hub, "size");
  peer.send(FrameType.take, {});
  actions.length = 0;
  peer.send(FrameType.size, { cols, rows });
  expect(actions).toEqual(accepted ? [["resize", cols, rows]] : []);
});

test("hello negotiation and labels preserve the reference wire contract", () => {
  const hub = makeHub(),
    peer = new Peer();
  hub.add(peer as any);
  peer.send(FrameType.hello, {
    v: 1,
    client: "app",
    label: "a\u0000b\u007f",
    versions: [1, 1],
  });
  expect(peer.messages()).toEqual([
    { type: 2, body: { screen: "initial" } },
    {
      type: 5,
      body: { controller: null, you: false, versions: [1, 1], pacer: "1.2.3" },
    },
  ]);
  peer.send(FrameType.take, {});
  expect(hub.controller).toBe("app:ab");
  const incompatible = new Peer();
  hub.add(incompatible as any);
  incompatible.send(FrameType.hello, { v: 1, versions: [2, 2] });
  expect(incompatible.messages()).toEqual([
    {
      type: 7,
      body: {
        code: 1,
        reason: "This session runs on an older pacer. Reopen to update.",
      },
    },
  ]);
});

test("pending viewers, duplicate hello, malformed control and disconnect preserve controller ownership", () => {
  const actions: unknown[] = [],
    hub = makeHub(actions),
    pending = new Peer();
  hub.add(pending as any);
  pending.send(FrameType.take, {});
  pending.send(FrameType.input, Buffer.from("no"));
  expect(hub.controller).toBeNull();
  pending.send(FrameType.hello, { v: 1, label: "a" });
  pending.send(FrameType.hello, { v: 1, label: "changed" });
  pending.send(FrameType.take, {});
  pending.send(FrameType.take, {});
  expect(hub.size).toBe(1);
  expect(hub.controller).toBe("cli:a");
  pending.send(FrameType.take, null);
  expect(pending.destroyed).toBe(false); // holder branch never reads force
  const other = join(hub, "b");
  other.send(FrameType.take, { force: "true" });
  expect(hub.controller).toBe("cli:a");
  other.send(FrameType.take, null);
  expect(other.destroyed).toBe(true);
  pending.destroy();
  expect(hub.controller).toBeNull();
  expect(hub.size).toBe(0);
  expect(actions.filter((a: any) => a[0] === "release")).toEqual([]);
});

test("labels count UTF-16 units, strip only C0/DEL and preserve empty labels", () => {
  const hub = makeHub(),
    p = new Peer();
  hub.add(p as any);
  p.send(FrameType.hello, {
    v: 1,
    client: "other",
    label: "x".repeat(63) + "😀\u0085",
  });
  p.send(FrameType.take, {});
  expect(hub.controller).toBe("cli:" + "x".repeat(63) + "\ud83d");
  const q = join(hub, "");
  q.send(FrameType.take, { force: true });
  expect(hub.controller).toBe("cli:");
  hub.destroy();
});

test("serialized hello and control are evaluated after admission, including closing", async () => {
  const queue: (() => void)[] = [],
    hub = new ViewerHub(
      () => wire(2, {}),
      () => [],
      (fn) => queue.push(fn),
    ),
    p = new Peer();
  hub.add(p as any);
  p.send(1, { v: 1 });
  p.send(8, {});
  expect(hub.size).toBe(0);
  while (queue.length) queue.shift()!();
  expect(hub.controller).toBe("cli:viewer");
  await hub.end(7);
  const rejected = new Peer();
  hub.add(rejected as any);
  expect(rejected.destroyed).toBe(true);
});
