import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { ViewerHub } from "../../src/session/viewers";
import { wire, WireDecoder, FrameType } from "../../src/session/framing";
class Peer extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  frames: Buffer[] = [];
  write(b: Buffer) {
    this.frames.push(b);
    return true;
  }
  end(b: Buffer, done?: () => void) {
    this.write(b);
    this.destroyed = true;
    done?.();
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}
export function recordViewers() {
  const scenarios = [
    [
      ["join", "a"],
      ["join", "b"],
      ["take", "a", {}],
      ["take", "a", {}],
      ["take", "b", {}],
      ["input", "b", "ignored"],
      ["size", "b", { cols: 80, rows: 24 }],
      ["take", "b", { force: "true" }],
      ["take", "b", { force: true }],
      ["input", "a", "ignored"],
      ["input", "b", "ok"],
      ["input", "b", ""],
      ["size", "b", { cols: 1000, rows: 500 }],
      ["size", "b", { cols: 1001, rows: 500 }],
      ["size", "b", { cols: 1.0, rows: 1e2 }],
      ["size", "b", { cols: "1", rows: 1 }],
      ["release", "a"],
      ["release", "b"],
      ["disconnect", "b"],
      ["disconnect", "a"],
    ],
    [
      ["join", "a"],
      ["take", "a", {}],
      ["disconnect", "a"],
      ["join", "b"],
      ["take", "b", {}],
      ["release", "b"],
    ],
    [
      ["join", "a", "cli:same"],
      ["join", "b", "cli:same"],
      ["join", "c", "app:same"],
      ["take", "a", {}],
      ["take", "b", {}],
      ["take", "b", { force: true }],
      ["take", "c", { force: true }],
      ["disconnect", "c"],
      ["release", "b"],
    ],
    Array.from({ length: 17 }, (_, i) => ["join", String(i)] as const),
  ] as const;
  return scenarios.map((steps) => {
    const events: unknown[] = [],
      peers = new Map<string, Peer>();
    const hub = new ViewerHub(
      () => wire(2, {}),
      () => null,
      (fn) => fn(),
      (k, l) => events.push([k, l]),
      () => {},
      {
        input: (b) => events.push(["input", b.toString()]),
        resize: (c, r) => events.push(["resize", c, r]),
        release: (l) => events.push(["release", l]),
      },
    );
    const trace = [];
    for (const step of steps) {
      const [kind, id] = step;
      let p = peers.get(id)!;
      if (kind === "join") {
        p = new Peer();
        peers.set(id, p);
        hub.add(p as any);
        p.emit(
          "data",
          wire(1, {
            v: 1,
            label: step.length > 2 ? (step[2] as string).slice(4) : id,
            client:
              step.length > 2 && (step[2] as string).startsWith("app:")
                ? "app"
                : "cli",
          }),
        );
      } else if (kind === "disconnect") p.destroy();
      else
        p.emit(
          "data",
          wire(
            FrameType[kind],
            kind === "input"
              ? Buffer.from(step[2] as string)
              : step.length > 2
                ? step[2]
                : {},
          ),
        );
      trace.push({
        controller: hub.controller,
        size: hub.size,
        events: events.splice(0),
        messages: [...peers].flatMap(([id, p]) => {
          const bytes = p.frames.splice(0);
          return new WireDecoder()
            .push(Buffer.concat(bytes))
            .filter((f) => f.type === 5)
            .map((f) => ({ id, body: JSON.parse(f.data.toString()) }));
        }),
      });
    }
    hub.destroy();
    return { steps, trace };
  });
}
if (import.meta.main)
  writeFileSync(
    new URL(
      "../../test/fixtures/sessions/viewers-parity.json",
      import.meta.url,
    ),
    JSON.stringify(recordViewers(), null, 2) + "\n",
  );
