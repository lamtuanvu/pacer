import { expect, test } from "bun:test";
import { idleSeconds, nextProgress } from "../src/supervisor/progress";

const base = { startedAt: 1000, logBytes: 0, lastOutputAt: null, files: 0, commits: 0 };

test("starting until the first output or 60 s", () => {
  expect(nextProgress({ ...base, now: 1030 }, 600).phase).toBe("starting");
  expect(nextProgress({ ...base, now: 1061 }, 600).phase).toBe("working");
  expect(nextProgress({ ...base, now: 1010, logBytes: 5, lastOutputAt: 1009 }, 600).phase).toBe("working");
});

test("a change in files or commits moves lastChangeAt", () => {
  const p1 = nextProgress({ ...base, now: 1100, files: 1 }, 600);
  expect(p1.lastChangeAt).toBe(1100);
  const p2 = nextProgress({ ...base, now: 1200, files: 1, prev: p1 }, 600);
  expect(p2.lastChangeAt).toBe(1100);
  const p3 = nextProgress({ ...base, now: 1300, files: 1, commits: 1, prev: p2 }, 600);
  expect(p3.lastChangeAt).toBe(1300);
});

test("idle after idleAfterS without output or changes; idleSeconds counts from the latest activity", () => {
  const p = nextProgress({ ...base, now: 2000, logBytes: 10, lastOutputAt: 1300 }, 600);
  expect(p.phase).toBe("idle");
  expect(idleSeconds(p, 1000, 2000)).toBe(700);
  expect(nextProgress({ ...base, now: 1800, logBytes: 10, lastOutputAt: 1300 }, 600).phase).toBe("working");
});

test("host defaults to local", () => {
  expect(nextProgress({ ...base, now: 1001 }, 600).host).toBe("local");
});
