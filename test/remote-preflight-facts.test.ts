import { expect, test } from "bun:test";
import { hasCommittedWork } from "../src/remote/committed-work";

const facts = "ancestor=1\ndirty=0\ndirty_files=0\ncommits=2\nemails=1\nsignoffs=1\nhead=abc\n";

test("both fresh and resumed attempts require one complete preflight", () => {
  expect(hasCommittedWork(facts)).toBe(true);
  expect(hasCommittedWork(facts.replace("commits=2", "commits=0"))).toBe(false);
  expect(hasCommittedWork(facts.replace("head=abc\n", ""))).toBe(false);
  expect(hasCommittedWork(facts + "commits=2\n")).toBe(false);
  expect(hasCommittedWork(facts.replace("commits=2", "commits=2x"))).toBe(false);
});
