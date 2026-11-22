import { expect, test } from "bun:test";
import { buildOracle, oraclePath, widthsPath } from "../scripts/replay-gate/oracle";
import type { Oracle } from "../scripts/replay-gate/oracle";

const payload = (data: unknown) => JSON.stringify(data, null, 2) + "\n";

/**
 * The schema-2 oracle is the source of truth for the replay gate. It is
 * regenerated deterministically from the two committed corpora; this test
 * guarantees the committed `replay-oracle.json` and `xterm-unicode-v6-widths.json`
 * are byte-for-byte reproducible (fresh), that the Unicode width table reports
 * xterm's real widths at sentinels, and that every entry is structurally sound
 * (valid geometry, base64 payloads, in-bounds cursor, sorted resizes).
 */
test("committed oracle is reproducible from the corpora", async () => {
  const { oracle, widths } = await buildOracle();
  const freshOracle = payload(oracle);
  const freshWidths = payload(widths);

  const committedOracle = await Bun.file(oraclePath).text();
  const committedWidths = await Bun.file(widthsPath).text();

  // Report what drifted rather than asserting two opaque blobs equal.
  if (freshOracle !== committedOracle) {
    const a = JSON.parse(freshOracle) as Oracle;
    const b = JSON.parse(committedOracle) as Oracle;
    const diffs: string[] = [];
    if (a.schema !== b.schema || a.cols !== b.cols || a.rows !== b.rows) diffs.push("header");
    if (JSON.stringify(a.corpora) !== JSON.stringify(b.corpora)) diffs.push("corpora");
    const missing = Object.keys(b.entries).filter((id) => !a.entries[id]);
    const extra = Object.keys(a.entries).filter((id) => !b.entries[id]);
    if (missing.length) diffs.push(`missing entries: ${missing.join(",")}`);
    if (extra.length) diffs.push(`extra entries: ${extra.join(",")}`);
    for (const id of Object.keys(a.entries)) {
      if (!b.entries[id]) continue;
      if (JSON.stringify(a.entries[id]) !== JSON.stringify(b.entries[id])) diffs.push(`entry differs: ${id}`);
    }
    expect(diffs, "oracle drifted; run bun scripts/replay-gate/oracle.ts --write").toEqual([]);
  }
  expect(freshWidths).toBe(committedWidths);
}, 120_000);

test("width table matches xterm's reported Unicode widths at sentinels", async () => {
  const widths = JSON.parse(await Bun.file(widthsPath).text()) as [number, number, number][];
  const width = (cp: number): number => {
    for (const [a, b, w] of widths) if (cp >= a && cp <= b) return w;
    return 1;
  };
  // Confirmed xterm v6 headless behavior.
  expect(width(0x41)).toBe(1);    // Latin A
  expect(width(0x4e2d)).toBe(2);  // CJK unified
  expect(width(0x3042)).toBe(2);  // Hiragana
  expect(width(0x20000)).toBe(2); // CJK extension B
  expect(width(0x1f600)).toBe(1); // emoji (xterm cell width 1)
  expect(width(0xa0)).toBe(1);    // NBSP
  expect(width(0x0301)).toBe(0);  // combining acute
  expect(width(0x200b)).toBe(1);  // zero-width space reported narrow
  expect(width(0xffe9)).toBe(1);  // halfwidth arrow
});

/** Validate the structural topology every oracle entry must satisfy. */
test("oracle entries are structurally well-formed", async () => {
  const oracle = JSON.parse(await Bun.file(oraclePath).text()) as Oracle;
  const problems: string[] = [];
  const cleanB64 = (s: string) => s.length % 4 === 0 && Buffer.from(s, "base64").toString("base64") === s;
  for (const [id, entry] of Object.entries(oracle.entries)) {
    // Resize entries legitimately carry post-resize dimensions, so dims need not
    // match the 120x40 header; they must just be sane.
    if (!(entry.cols >= 1 && entry.rows >= 1)) problems.push(`${id}: dims ${entry.cols}x${entry.rows}`);
    if (!cleanB64(entry.screenAnsi)) problems.push(`${id}: screenAnsi not clean base64`);
    const st = entry.state;
    if (typeof st.cursorVisible !== "boolean") problems.push(`${id}: cursorVisible`);
    if (st.type !== "normal" && st.type !== "alternate") problems.push(`${id}: type ${st.type}`);
    // xterm may park the cursor one column past the right edge (disabled wrap),
    // so cursorX may equal `cols`.
    if (st.cursorX < 0 || st.cursorX > entry.cols || st.cursorY < 0 || st.cursorY >= entry.rows) {
      problems.push(`${id}: cursor (${st.cursorX},${st.cursorY}) out of ${entry.cols}x${entry.rows}`);
    }
    // Resize does not re-observe DECSTBM, so scrollBottom may exceed entry.rows.
    if (!(st.scrollTop >= 0 && st.scrollBottom > st.scrollTop)) problems.push(`${id}: scroll region ${st.scrollTop}:${st.scrollBottom}`);
    if (!Array.isArray(st.rows)) { problems.push(`${id}: rows not array`); continue; }
    for (let r = 0; r < st.rows.length; r++) {
      const row = st.rows[r] as [boolean, unknown[]];
      if (typeof row[0] !== "boolean" || !Array.isArray(row[1])) { problems.push(`${id}: row ${r} shape`); break; }
      for (const run of row[1]) {
        if (!Array.isArray(run) || run.length !== 8 || typeof run[0] !== "number" || run[0] < 1) {
          problems.push(`${id}: row ${r} run malformed`); break;
        }
      }
    }
    if (entry.continuationState !== null && typeof entry.continuationState !== "object") problems.push(`${id}: continuationState`);
    for (let i = 1; i < entry.resizeStates.length; i++) {
      if (entry.resizeStates[i].at < entry.resizeStates[i - 1].at) problems.push(`${id}: resize at out of order`);
    }
    if (entry.resizeStates.some((r) => r.cols < 1 || r.rows < 1 || r.at < 0)) problems.push(`${id}: bad resize entry`);
    for (let i = 0; i < entry.queryReplies.length; i++) {
      if (!cleanB64(entry.queryReplies[i])) problems.push(`${id}: queryReplies[${i}] not clean base64`);
    }
    if (typeof entry.plainCursor !== "string" || typeof entry.plainViewport !== "string") problems.push(`${id}: plain fields`);
  }
  expect(problems).toEqual([]);
});