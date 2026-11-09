import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { ViewerHub, type DeliveryTiming } from "../../src/session/viewers";
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Session protocol 1.2 hosts (ADR 0023): no controller, read-only viewers, size follows the active client. */
const modern = { versions: [1, 2] as [number, number] };
export async function recordViewers() {
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
  const sync = cases.map(({ steps, host }) => {
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
  // Delivery window (ADR 0023, decision 4). Timing is shrunk so the golden can advance real time deterministically.
  const DELIVERY: Partial<DeliveryTiming> = {
    quietMs: 50,
    windowMs: 100,
    timeoutMs: 300,
    maxWindowMs: 400,
  };
  type Step = (string | number | object | null)[];
  type ScenarioStep = readonly unknown[];
  const run = (
    steps: ScenarioStep[],
    timing: Partial<DeliveryTiming>,
    refuseDeliver = false,
  ) => {
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
      { pacer: "0.0.0-golden", versions: [1, 2] as [number, number] },
      timing,
      refuseDeliver,
    );
    const trace: unknown[] = [];
    return (async () => {
      for (const step of steps) {
        const kind = step[0] as string, id = step[1] as string;
        const p = peers.get(id)!;
        if (kind === "join") {
          const peer = new Peer();
          peers.set(id, peer);
          hub.add(peer as any);
          const label = typeof step[2] === "string" ? step[2] : null;
          peer.emit(
            "data",
            wire(1, {
              v: 1,
              label: label ? label.slice(4) : id,
              client: label?.startsWith("app:") ? "app" : "cli",
              ...((step as Step)[3] as object | undefined),
            }),
          );
        } else if (kind === "disconnect") p.destroy();
        else if (kind === "advance") await sleep(step[1] as unknown as number);
        else if (kind === "deliver")
          p.emit("data", wire(FrameType.deliver, (step as Step)[2] ?? {}));
        else
          p.emit(
            "data",
            wire(
              FrameType[kind as keyof typeof FrameType] as number,
              kind === "input"
                ? Buffer.from(step[2] as string)
                : (step as Step).length > 2
                  ? (step as Step)[2]
                  : {},
            ),
          );
        trace.push({
          controller: hub.controller,
          active: hub.active,
          size: hub.size,
          events: events.splice(0),
          messages: [...peers].flatMap(([id, peer]) => {
            const bytes = peer.frames.splice(0);
            return new WireDecoder()
              .push(Buffer.concat(bytes))
              .filter((f) => f.type === 5 || f.type === 14 || f.type === 15)
              .map((f) => ({ id, body: JSON.parse(f.data.toString()) }));
          }),
        });
      }
      hub.destroy();
      return {
        host: [1, 2] as [number, number],
        timing,
        ...(refuseDeliver ? { refuseDeliver: true } : {}),
        steps,
        trace,
      };
    })();
  };
  const delivery = await Promise.all([
    // Grant at once (no input yet), the requester's paste and Enter are deliveries, others' input is held and applies after.
    run([
      ["join", "pacer", null, modern],
      ["join", "human", null, modern],
      ["deliver", "pacer", {}],
      ["input", "pacer", "paste"],
      ["input", "pacer", "\r"],
      ["input", "human", "held"],
      ["deliver", "pacer", { done: true }],
      ["input", "human", "x"],
    ], DELIVERY),
    // A pending human line blocks the grant; Enter ends it, then the quiet period elapses and the window is granted.
    run([
      ["join", "pacer", null, modern],
      ["join", "human", null, modern],
      ["input", "human", "typing"],
      ["deliver", "pacer", {}],
      ["advance", 20],
      ["input", "human", "\r"],
      ["advance", 90],
      ["input", "pacer", "ans"],
      ["deliver", "pacer", { done: true }],
    ], DELIVERY),
    // The window expires unused: held input is applied, the requester's late input is dropped until a new window.
    run([
      ["join", "pacer", null, modern],
      ["join", "human", null, modern],
      ["deliver", "pacer", {}],
      ["input", "human", "waiting"],
      ["advance", 160],
      ["input", "pacer", "late"],
      ["input", "pacer", "\r"],
      ["deliver", "pacer", { done: true }],
    ], DELIVERY),
    // Backspace and DEL clear the pending line, so the quiet period grants.
    run([
      ["join", "pacer", null, modern],
      ["join", "human", null, modern],
      ["input", "human", "ab"],
      ["input", "human", "\x7f"],
      ["deliver", "pacer", {}],
      ["input", "human", "\x7f"],
      ["advance", 90],
      ["input", "pacer", "paste"],
      ["deliver", "pacer", { done: true }],
    ], DELIVERY),
    // A request that never admits (pending line) times out and names the client that typed.
    run([
      ["join", "pacer", null, modern],
      ["join", "app", "app:Pacer desktop", modern],
      ["input", "app", "half a line"],
      ["deliver", "pacer", {}],
      ["advance", 380],
    ], DELIVERY),
    // One window at a time: a second request waits its turn; a duplicate is refused.
    run([
      ["join", "one", null, modern],
      ["join", "two", null, modern],
      ["deliver", "one", {}],
      ["deliver", "two", {}],
      ["deliver", "two", {}],
      ["deliver", "one", { done: true }],
      ["deliver", "two", { done: true }],
    ], DELIVERY),
    // cancel ends the window, flushes held input and reports it.
    run([
      ["join", "pacer", null, modern],
      ["join", "human", null, modern],
      ["deliver", "pacer", {}],
      ["input", "human", "mine"],
      ["deliver", "pacer", { cancel: true }],
    ], DELIVERY),
    // read-only viewers are refused; 1.1 clients' deliver is ignored.
    run([
      ["join", "ro", "cli:ro", { ...modern, readOnly: true }],
      ["deliver", "ro", {}],
      ["join", "old", "cli:old", {}],
      ["deliver", "old", {}],
    ], DELIVERY),
    // A requester that started typing is cut off at maxWindowMs, releasing held input.
    run(
      [
        ["join", "pacer", null, modern],
        ["join", "human", null, modern],
        ["deliver", "pacer", {}],
        ["input", "pacer", "PASTE"],
        ["input", "human", "held"],
        ["advance", 80],
        ["advance", 260],
      ],
      { ...DELIVERY, maxWindowMs: 300 },
    ),
    // A requester's delivery does not make it active, so size keeps following the human.
    run([
      ["join", "human", null, modern],
      ["join", "pacer", null, modern],
      ["size", "human", { cols: 100, rows: 30 }],
      ["focus", "human"],
      ["deliver", "pacer", {}],
      ["input", "pacer", "paste\r"],
      ["deliver", "pacer", { done: true }],
    ], DELIVERY),
    // The built-in terminal refuses every deliver.
    run([
      ["join", "pacer", null, modern],
      ["deliver", "pacer", {}],
    ], DELIVERY, true),
  ]);
  return [...sync, ...delivery];
}
if (import.meta.main)
  writeFileSync(
    new URL(
      "../../test/fixtures/sessions/viewers-parity.json",
      import.meta.url,
    ),
    JSON.stringify(await recordViewers(), null, 2) + "\n",
  );