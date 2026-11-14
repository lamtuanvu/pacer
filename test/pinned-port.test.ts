import { expect, test } from "bun:test";
import { DEFAULT_PORT } from "../src/serve/constants";
import { pinnedPort } from "./helpers";

test("spawned test processes get a closed sandbox port, never the real service port", async () => {
  const env = pinnedPort({ HOME: "/tmp/pinned-port", PACER_PORT: String(DEFAULT_PORT) });
  expect(Number(env.PACER_PORT)).toBeGreaterThan(0);
  expect(Number(env.PACER_PORT)).not.toBe(DEFAULT_PORT);
  expect(await fetch(`http://127.0.0.1:${env.PACER_PORT}/health`).then(() => "open", () => "closed")).toBe("closed");
  expect(pinnedPort({ PACER_PORT: String(DEFAULT_PORT) }, 5555).PACER_PORT).toBe("5555");
  for (const port of [DEFAULT_PORT, 0, -1, 65536, 1.5]) expect(() => pinnedPort({}, port)).toThrow("sandbox port");
});
