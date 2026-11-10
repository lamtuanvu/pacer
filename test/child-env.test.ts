import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { childEnv, pinnedEnv } from "./child-env";

test("child environments isolate the home and never use the default service port", () => {
  const env = childEnv("/tmp/test-home");
  expect(env.HOME).toBe("/tmp/test-home");
  expect(env.PACER_HOME).toBe("/tmp/test-home/.pacer");
  expect(Number(env.PACER_PORT)).toBeGreaterThan(0);
  expect(env.PACER_PORT).not.toBe("4317");
  expect(new URL(env.OLLAMA_HOST!).port).not.toBe("11434");
  expect(env.LMS_API_SERVER_INFO_PATH).toBeDefined();
  expect([1234, 41343, 11434, 4317]).not.toContain(JSON.parse(readFileSync(env.LMS_API_SERVER_INFO_PATH!, "utf8")).port);
  expect(childEnv("/tmp/test-home", 12345).PACER_PORT).toBe("12345");
  expect(() => childEnv("/tmp/test-home", 4317)).toThrow();
  expect(() => pinnedEnv({})).toThrow();
  expect(() => pinnedEnv({ PACER_PORT: "4317" })).toThrow();
  expect(pinnedEnv(env)).toBe(env);
});
