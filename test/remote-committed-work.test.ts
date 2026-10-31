import { expect, test } from "bun:test";
import { hasCommittedWork, hasNoCommittedWork } from "../src/remote/committed-work";

const base = "a".repeat(40);
const empty = `ancestor=1\ndirty=0\ndirty_files=\ncommits=0\nemails=\nsignoffs=\nhead=${base}\n`;

test("only a complete clean base preflight can prove no remote committed work", () => {
  expect(hasNoCommittedWork(empty, base)).toBe(true);
  expect(hasCommittedWork(empty)).toBe(false);
  for (const changed of [
    empty.replace("ancestor=1", "ancestor=0"),
    empty.replace("dirty=0", "dirty=1"),
    empty.replace("commits=0", "commits=1"),
    empty.replace(`head=${base}`, `head=${"b".repeat(40)}`),
    `${empty}warning=unexpected\n`,
    `warning\n${empty}`,
  ]) expect(hasNoCommittedWork(changed, base)).toBe(false);
});
