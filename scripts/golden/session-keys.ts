/** Record AttachKeys behavior from the TypeScript implementation. */
import { writeFileSync } from "node:fs";
import { AttachKeys } from "../../src/session/attach";
import { WireDecoder } from "../../src/session/framing";

export function recordKeys() {
  const cases: {
    name: string;
    takeover?: boolean;
    steps: [string, unknown][];
  }[] = [
    {
      name: "watch",
      steps: [
        ["push", "631b5b313b326371"],
        ["push", "71"],
      ],
    },
    {
      name: "refuse-confirm",
      steps: [
        ["take", false],
        [
          "state",
          { you: false, controller: "app:a\u0007b", reason: "refused" },
        ],
        ["push", "1b5b313b327959"],
      ],
    },
    {
      name: "control",
      takeover: true,
      steps: [
        ["state", { you: true }],
        ["push", "61621d"],
        ["push", "1d631d72"],
        ["push", "1d78"],
        ["push", "1d64"],
      ],
    },
    {
      name: "escapes",
      steps: [
        ["push", "1b5d746578741b"],
        ["push", "5c63"],
        ["push", "03"],
      ],
    },
    {
      name: "cancel",
      steps: [
        ["take", false],
        ["state", { you: false, controller: "cli:x", reason: "refused" }],
        ["push", "6e63"],
      ],
    },
    {
      name: "switch",
      steps: [
        ["state", { you: true }],
        ["push", "1d"],
        ["state", { you: false }],
        ["state", { you: true }],
        ["push", "64"],
      ],
    },
  ];
  for (const hex of [
    "1b5b313b3263",
    "1b4f50",
    "1b5d7469746c6507",
    "1b507374721b5c",
    "1b5e746578741b5c",
    "1b5f7465787407",
    "1b5873747207",
    "1b2041",
  ]) {
    for (let split = 0; split <= hex.length; split += 2)
      cases.push({
        name: `reply-${hex}-${split}`,
        steps: [
          ["push", hex.slice(0, split)],
          ["push", hex.slice(split) + "63"],
          ["push", "71"],
        ],
      });
  }
  for (const byte of [0, 3, 27, 29, 89, 99, 100, 110, 113, 114, 121, 255]) {
    cases.push({
      name: `watch-byte-${byte}`,
      steps: [["push", byte.toString(16).padStart(2, "0")]],
    });
    cases.push({
      name: `control-byte-${byte}`,
      steps: [
        ["state", { you: true }],
        ["push", "1d"],
        ["push", byte.toString(16).padStart(2, "0")],
      ],
    });
  }
  return cases.map((row) => {
    const frames: { type: number; hex: string }[] = [],
      prompts: string[] = [],
      detached: boolean[] = [];
    const keys = new AttachKeys(
      (bytes) => {
        for (const f of new WireDecoder().push(bytes))
          frames.push({ type: f.type, hex: f.data.toString("hex") });
      },
      (text) => prompts.push(text),
      "takeover" in row && row.takeover,
    );
    for (const [action, value] of row.steps) {
      if (action === "push")
        detached.push(keys.push(Buffer.from(value as string, "hex")));
      else if (action === "state")
        keys.controlState(
          value as {
            you?: boolean;
            controller?: string | null;
            reason?: string;
          },
        );
      else keys.take(value as boolean);
    }
    return { ...row, frames, prompts, detached };
  });
}
if (import.meta.main)
  writeFileSync(
    new URL("../../test/fixtures/sessions/keys-parity.json", import.meta.url),
    JSON.stringify(recordKeys(), null, 2) + "\n",
  );
