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
  // Session protocol 1.2 hosts (ADR 0023): no controller, read-only viewers, size follows the active client.
  const modern = { versions: [1, 2] };
  const shared = [
    [
      ["join", "a", null, modern],
      ["join", "b", null, modern],
      ["join", "r", null, { ...modern, readOnly: true }],
      ["input", "a", "ab"],
      ["input", "b", "cd"],
      ["input", "b", "ef"],
      ["input", "a", ""],
      ["input", "r", "dropped"],
      ["size", "r", { cols: 10, rows: 10 }],
      ["focus", "r"],
      ["take", "r", { force: true }],
      ["size", "a", { cols: 100, rows: 30 }],
      ["size", "b", { cols: 80, rows: 24 }],
      ["focus", "a"],
      ["focus", "a"],
      ["size", "a", { cols: 1001, rows: 30 }],
      ["size", "a", { cols: 90, rows: 20 }],
      ["input", "b", "x"],
      ["input", "a", "\u001b[?62;22c\u001b[>0;276;0c"],
      ["input", "a", "y\u001b]11;rgb:0000/0000/0000\u001b\\z\u001b[1;2R"],
      ["disconnect", "b"],
      ["size", "a", { cols: 70, rows: 20 }],
      ["take", "a", {}],
      ["release", "a"],
      ["disconnect", "a"],
    ],
    [
      ["join", "old", "cli:old"],
      ["join", "app", "app:pane"],
      ["input", "old", "early"],
      ["size", "old", { cols: 50, rows: 20 }],
      ["focus", "old"],
      ["take", "old", {}],
      ["take", "app", { force: true }],
      ["take", "old", {}],
      ["input", "old", "one"],
      ["input", "app", "two"],
      ["size", "app", { cols: 90, rows: 30 }],
      ["release", "app"],
      ["release", "app"],
      ["input", "app", "after"],
      ["join", "new", null, modern],
      ["take", "new", {}],
      ["release", "new"],
      ["release", "old"],
      ["disconnect", "old"],
    ],
  ] as const;
  const cases = [
    ...scenarios.map((steps) => ({ steps, host: undefined })),
    ...shared.map((steps) => ({ steps, host: [1, 2] as [number, number] })),
  ];
  return cases.map(({ steps, host }) => {
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
      host ? { pacer: "0.0.0-golden", versions: host } : undefined,
    );
    const trace = [];
    for (const step of steps) {
      const [kind, id] = step;
      let p = peers.get(id)!;
      if (kind === "join") {
        p = new Peer();
        peers.set(id, p);
        hub.add(p as any);
        const label = typeof step[2] === "string" ? step[2] : null;
        p.emit(
          "data",
          wire(1, {
            v: 1,
            label: label ? label.slice(4) : id,
            client: label?.startsWith("app:") ? "app" : "cli",
            ...((step as readonly unknown[])[3] as object | undefined),
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
        active: hub.active,
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
    return { ...(host ? { host } : {}), steps, trace };
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
