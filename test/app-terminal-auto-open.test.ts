import { expect, test } from "bun:test";
import { ensurePanelTerminal } from "../app/src/screens/terminal/auto-open";
import type { TerminalRecord } from "../src/terminal/workspace";

function fixture(existing = false) {
  let creates = 0;
  const tab = { id: "one", title: "zsh" } as TerminalRecord;
  const api = { call: async <T>(op: string): Promise<T> => {
    await Bun.sleep(5);
    if (op === "terminal.list") return (existing ? [tab] : []) as T;
    creates++; existing = true; return tab as T;
  } };
  return { api, creates: () => creates, kill: () => { existing = false; } };
}
test("opening an empty panel creates one shell", async () => {
  const f = fixture();
  expect(await ensurePanelTerminal(f.api, "")).toMatchObject([{ title: "zsh" }]);
  expect(f.creates()).toBe(1);
});
test("opening a panel with an existing session reuses it", async () => {
  const f = fixture(true);
  expect(await ensurePanelTerminal(f.api, "")).toHaveLength(1);
  expect(f.creates()).toBe(0);
});
test("overlapping opens and strict effects share one in-flight creation", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([ensurePanelTerminal(f.api, ""), ensurePanelTerminal(f.api, "")]);
  expect(a).toEqual(b);
  expect(f.creates()).toBe(1);
  f.kill();
  await ensurePanelTerminal(f.api, ""); // a later panel opening may create again
  expect(f.creates()).toBe(2);
});
