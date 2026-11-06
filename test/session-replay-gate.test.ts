import { expect, test } from "bun:test";
import { compareReplay, loadCorpus, reference } from "../scripts/spike/vt100-replay/replay";

/**
 * Production replay stays on TypeScript `Screen` until the vt100 native gate passes.
 * Session WebSocket routes must remain forwarded while native replay is NO-GO.
 */
test("TS checkpoint replay passes the synthetic vt100 corpus", async () => {
  const corpus = await loadCorpus();
  expect(corpus.streams.length).toBeGreaterThanOrEqual(20);
  const failures: { id: string; differences: string[] }[] = [];
  for (const stream of corpus.streams) {
    const baseline = await reference(stream);
    const selfCheck = await compareReplay(baseline, baseline.replay);
    if (selfCheck.differences.length) {
      failures.push({ id: stream.id, differences: selfCheck.differences });
    }
  }
  expect(failures).toEqual([]);
});
