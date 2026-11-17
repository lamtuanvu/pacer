import { expect, test } from "bun:test";
import { h } from "preact";
import render from "preact-render-to-string";
import { OfflineNotice, updateInProgress } from "../app/src/shell/OfflineNotice";
import { reduceStore, initialState } from "../app/src/data/store";
import type { Job } from "../src/api/read-model/types";

const job = (over: Partial<Job>): Job => ({ id: "j", kind: "update.apply", target: "pacer", state: "running", steps: [{ name: "Restart", state: "running" }], startedAt: 1, ...over } as Job);

test("a running service update is recognised from job events", () => {
  expect(updateInProgress({ a: job({}) })).toBe(true);
  expect(updateInProgress({ a: job({ state: "passed" }) })).toBe(false);
  expect(updateInProgress({ a: job({ kind: "host.check" }) })).toBe(false);
  expect(updateInProgress({})).toBe(false);
  // Before the Restart step, a dropped connection is not the update's restart.
  expect(updateInProgress({ a: job({ steps: [{ name: "Download", state: "running" }, { name: "Restart", state: "pending" }] }) })).toBe(false);
});

test("reaching pacer again settles a restarting update even if its closing event was missed", () => {
  const other = job({ id: "b", kind: "host.check" });
  const state = { ...initialState(), jobs: { a: job({}), b: other } };
  for (const type of ["connected", "reconnected"] as const) {
    const next = reduceStore(state, { type });
    expect(next.jobs).toEqual({ b: other });
    expect(updateInProgress(next.jobs)).toBe(false);
  }
});

test("the offline notice says pacer is restarting to finish an update", () => {
  const html = render(<OfflineNotice lastUpdate={Date.now() / 1000 - 60} updating />);
  expect(html).toContain("Last update");
  expect(html).toContain("Updating pacer");
  expect(html).not.toContain("Reconnecting to pacer");
  expect(render(<OfflineNotice lastUpdate={0} />)).toContain("Reconnecting to pacer");
});
