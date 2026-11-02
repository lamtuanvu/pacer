import { cellWidth, clip, safeText, wrap } from "../../../src/dashboard/frame";
import { displayTitle } from "../../../src/view-model/titles";
import { wrapPath } from "../../../src/dashboard/screens/settings";
import { ago, clock, elapsed } from "../../../src/view-model/time";
// ECMAScript edge values which Rust's native conversions/whitespace/byte length differ on.
export function semantics() {
  return {
    titles: [
      { goal: "# Fix **tests**. Then check output." },
      { goal: "Goal:\n```sh\necho test\n```\n- [Fix retry](https://example.com/a(b)) in `foo_bar`." },
      { goal: "a ".repeat(60) },
      { goal: "Fallback", title: "\ufeff   " },
      { goal: "Keep this (unfinished" },
      { goal: "A complete custom goal", title: "A custom title" },
      { goal: "\u0085# Keep this prefix" },
      { goal: "a_ __b__ c_d and e__f" },
      { goal: "#\ufeffUnicode whitespace\ufeff #" },
      { goal: "😀".repeat(2100) },
    ].map(input => ({ input, output: displayTitle(input) })),
    rounds: [-2.5, -1.5, -0.5, -0.1, 0.49999999999999994, 0.5, 1.5, 2.5, 4503599627370497].map(input => ({ input, output: String(Math.round(input)) })),
    numbers: ["", "\ufeff 12.5\u00a0", "\u008512", "0x20", "0x1fffffffffffff4445", "0x1fffffffffffff4444", "0b101", "0o17", "0o17777777777777744445", "0b" + "1".repeat(75), "0x" + "0".repeat(270) + "1", "0x1" + "0".repeat(270), "0x", "-0x1", "0b2", "0o8", "1_000", ".5", "1.", "1e", "-0", "1e21", "1e-7", "Infinity", "+Infinity", "-Infinity", "inf", "NaN", true, false, [], [12], [""], [1, 2], {}].map(input => ({ input, output: String(Number(input)) })),
    strings: [1e21, 1e20, 1e-7, 1e-6, -0, 2.675, true, [1, null, "x"], {}].map(input => ({ input, output: String(input) })),
    times: [-0.1, 0, 59.9, 60, 3599.9, 3600, 86400, 1e23].map(input => ({ input, ago: ago(0, input), elapsed: elapsed(input) })),
    clocks: [-0.1, 0, 86399.99, 86400, 86400 * 3, 86400 * 8, 86400 * 370].map(at => ({ at, now: 86400, output: clock(at, 86400, "UTC") })),
    text: ["a\x1bb\u0085c", "界e\u0301😀", "a\ufeffbc", "a\u0085bc", "\u0301start", "😀\u0301 text", "one\u00a0two\ufeffthree", "a\u2028b\n\r\nc"].flatMap(input => [0, 1, 3, 8].map(width => ({ input, width, safe: safeText(input), cells: cellWidth(input), clipped: clip(input, width), wrapped: wrap(input, width, 3) }))),
    paths: ["/tmp/fixture/😀/界界界界界/file", "/usr/local/bin/pacer", "/" + "a".repeat(30), "/1234567😀/tail", "/😀".repeat(12), ""].flatMap(input => [8, 12, 20].map(width => ({
      input, width,
      // Preserve JS slice boundaries, including isolated surrogates, for Rust.
      units: wrapPath(input, width).map(row => Array.from({ length: row.length }, (_, i) => row.charCodeAt(i))),
    }))),
  };
}
