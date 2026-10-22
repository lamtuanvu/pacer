import { expect, test } from "bun:test";
import { prepareManualCandidate } from "../scripts/live/ota-candidate";

test("managed fixture uses authorized manual download without claiming automatic behavior", async () => {
  const calls: unknown[] = [];
  const states = [
    {phase:"idle",target:null,actions:["check"]},
    {phase:"idle",target:"0.2.4",actions:["download"]},
    {phase:"ready",target:"0.2.4",actions:["restart"]},
  ];
  await prepareManualCandidate({
    mutate: async (action, extra) => { calls.push([action, extra]); },
    waitStatus: async predicate => {
      const next = states.shift()!;
      expect(predicate(next as any)).toBe(true);
      if (next.target) expect(predicate({...next,target:"9.9.9"} as any)).toBe(false);
      return next as any;
    },
  });
  expect(calls).toEqual([["configure",{autoDownload:false}],["check",undefined],["download",undefined]]);
});
test("already verified ready candidate needs no duplicate download", async () => {
  const calls: string[] = [];
  await prepareManualCandidate({mutate:async action=>{calls.push(action);},waitStatus:async predicate=>{
    const ready={phase:"ready",target:"0.2.4",actions:["restart","check"]};
    expect(predicate(ready as any)).toBe(true);return ready as any;
  }});
  expect(calls).toEqual(["configure","check"]);
});
