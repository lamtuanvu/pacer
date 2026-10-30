import { expect, test } from "bun:test";
import { processIdentity, signalSameProcess } from "../src/update/desktop/process-identity";

async function sleeper() {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && !processIdentity(child.pid); i++) await Bun.sleep(20);
  return child;
}

test("a changed process identity is never signalled", async () => {
  const child = await sleeper();
  try {
    const identity = processIdentity(child.pid)!;
    expect(identity).not.toBeNull();
    expect(signalSameProcess({ ...identity, birth: `${identity.birth}9` }, "SIGTERM")).toBe(false);
    expect(signalSameProcess({ ...identity, bootId: "another-boot" }, "SIGTERM")).toBe(false);
    await Bun.sleep(100);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("the recorded process is signalled, and nothing after it exits", async () => {
  const child = await sleeper();
  const identity = processIdentity(child.pid)!;
  expect(signalSameProcess(identity, "SIGTERM")).toBe(true);
  await child.exited;
  expect(child.signalCode).toBe("SIGTERM");
  expect(signalSameProcess(identity, "SIGTERM")).toBe(false);
});

test("init and invalid PIDs are refused before any lookup", () => {
  expect(signalSameProcess({ pid: 1, bootId: "x", birth: "1" }, "SIGTERM")).toBe(false);
  expect(signalSameProcess({ pid: 0, bootId: "x", birth: "1" }, "SIGTERM")).toBe(false);
  expect(signalSameProcess({ pid: -5, bootId: "x", birth: "1" }, "SIGTERM")).toBe(false);
});
