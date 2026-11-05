import { describe, expect, test } from "bun:test";
import { Screen } from "../src/session/screen";
import { compareReplay, loadCorpus, reference } from "../scripts/spike/vt100-replay/replay";

describe("Screen checkpoint DECTCEM / origin restore", () => {
  test("serializes CSI ? 25 l so a restored checkpoint stays cursor-hidden", async () => {
    const screen = new Screen(120, 40);
    try {
      await screen.output(Buffer.from("hello\x1b[?25l"));
      const snap = screen.snapshot();
      expect(snap.screenAnsi.endsWith("\x1b[?25l")).toBe(true);

      const restored = new Screen(120, 40);
      try {
        await restored.restore(snap);
        expect(restored.snapshot().screenAnsi.endsWith("\x1b[?25l")).toBe(true);
      } finally { restored.dispose(); }
    } finally { screen.dispose(); }
  });

  test("does not append DECTCEM when the cursor remains visible", async () => {
    const screen = new Screen();
    try {
      await screen.output(Buffer.from("hi\r\n"));
      expect(screen.snapshot().screenAnsi.includes("\x1b[?25")).toBe(false);
    } finally { screen.dispose(); }
  });

  test("restores origin-mode cursor after SerializeAddon DECOM ordering", async () => {
    const corpus = await loadCorpus();
    const data = corpus.streams.find(stream => stream.id === "scroll-region-origin")!.data;
    const screen = new Screen(120, 40);
    try {
      await screen.output(Buffer.from(data));
      const before = { x: screen.term.buffer.active.cursorX, y: screen.term.buffer.active.cursorY };
      expect(before).toEqual({ x: 3, y: 19 });

      const restored = new Screen(120, 40);
      try {
        await restored.restore(screen.snapshot());
        expect({
          x: restored.term.buffer.active.cursorX,
          y: restored.term.buffer.active.cursorY,
        }).toEqual(before);
      } finally { restored.dispose(); }
    } finally { screen.dispose(); }
  });

  test("synthetic corpus source-versus-checkpoint has no state differences", async () => {
    const corpus = await loadCorpus();
    const failures: { id: string; differences: string[] }[] = [];
    for (const stream of corpus.streams) {
      const source = await reference(stream);
      const result = await compareReplay(source, source.replay);
      if (result.differences.length) failures.push({ id: stream.id, differences: result.differences });
    }
    expect(failures).toEqual([]);
  });
});
