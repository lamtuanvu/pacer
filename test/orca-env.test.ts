import { expect, test } from "bun:test";
import { sanitizedOrcaEnv } from "../src/orca/env";

test("Orca account calls remove caller attestation without changing unrelated environment", () => {
  const source = {
    PATH: "/usr/bin",
    ORCA_USER_DATA_PATH: "/tmp/orca-fixture",
    ORCA_AGENT_SESSION_ID: "foreign-session",
    ORCA_AGENT_SESSION_ID_ENV: "CUSTOM_ORCA_SESSION",
    CUSTOM_ORCA_SESSION: "foreign-custom-session",
    ORCA_TERMINAL_HANDLE: "foreign-terminal",
    ORCA_PANE_KEY: "foreign-pane",
    ORCA_TAB_ID: "foreign-tab",
    ORCA_WORKTREE_ID: "foreign-worktree",
    ORCA_AGENT_LAUNCH_TOKEN: "foreign-token",
    ORCA_AGENT_HOOK_STATUS: "foreign-hook",
    ORCA_SESSION_PARENT: "foreign-parent",
  };
  const env = sanitizedOrcaEnv(source);
  expect(env).toEqual({ PATH: "/usr/bin", ORCA_USER_DATA_PATH: "/tmp/orca-fixture" });
  expect(source.CUSTOM_ORCA_SESSION).toBe("foreign-custom-session");
});
