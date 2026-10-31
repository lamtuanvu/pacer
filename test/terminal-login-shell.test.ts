import { expect, test } from "bun:test";
import { resolveLoginShell, type ShellDeps } from "../src/terminal/login-shell";

function fixture(platform: string, output: string, executable = ["/bin/zsh", "/bin/sh"]): ShellDeps {
  return { platform, username: "fixture", uid: 501, read: () => "/bin/sh\n/bin/zsh\n", executable: path => executable.includes(path), lookup: () => output };
}
test("macOS account shell wins over service SHELL and uses argument vectors", () => {
  const deps = fixture("darwin", "UserShell: /bin/zsh\n");
  let argv: string[] = [];
  deps.lookup = args => { argv = args; return "UserShell: /bin/zsh\n"; };
  expect(resolveLoginShell({ SHELL: "/bin/sh" }, deps)).toBe("/bin/zsh");
  expect(argv).toEqual(["/usr/bin/dscl", ".", "-read", "/Users/fixture", "UserShell"]);
});
test("Linux resolves passwd field seven by account uid", () => {
  const deps = fixture("linux", "fixture:x:501:20::/home/fixture:/bin/zsh\n");
  let argv: string[] = [];
  deps.lookup = args => { argv = args; return "fixture:x:501:20::/home/fixture:/bin/zsh\n"; };
  expect(resolveLoginShell({}, deps)).toBe("/bin/zsh");
  expect(argv).toEqual(["getent", "passwd", "501"]);
});
test("invalid account shell falls back to validated SHELL then sh", () => {
  for (const output of ["UserShell: relative/zsh", "UserShell: /missing", "UserShell: /bin/zsh\0bad"]) {
    expect(resolveLoginShell({ SHELL: "/bin/zsh" }, fixture("darwin", output))).toBe("/bin/zsh");
    expect(resolveLoginShell({ SHELL: "relative" }, fixture("darwin", output))).toBe("/bin/sh");
  }
});
test("unlisted executable shells are valid; lookup failures and missing shells file fall back", () => {
  const deps = fixture("linux", "fixture:x:501:20::/home/fixture:/opt/fish", ["/opt/fish", "/bin/sh"]);
  deps.read = () => { throw new Error("missing"); };
  expect(resolveLoginShell({}, deps)).toBe("/opt/fish");
  deps.lookup = () => { throw new Error("unavailable"); };
  expect(resolveLoginShell({}, deps)).toBe("/bin/sh");
});
