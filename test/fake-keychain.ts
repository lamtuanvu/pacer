import type { RunFn } from "../src/types";

/**
 * A `security` stand-in keyed by service and account, shared by every home that uses it.
 * `failWrite` and `failRead` return an exit code for an account to simulate a failing Keychain:
 * a failed write leaves the item unchanged (code 0 models `security -i`, which can exit 0 after a failed command).
 */
export function fakeKeychain() {
  const items = new Map<string, Buffer>();
  const accounts = new Set<string>();
  const fail: { write?: (account: string) => number | undefined; read?: (account: string) => number | undefined } = {};
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];
  const one = (args: string[]) => {
    const account = flag(args, "-a"), key = `${flag(args, "-s")}|${account}`;
    switch (args[0]) {
      case "add-generic-password": {
        const code = fail.write?.(account);
        if (code !== undefined) return { code, stdout: "", stderr: "" };
        accounts.add(account);
        items.set(key, Buffer.from(flag(args, "-X"), "hex"));
        return { code: 0, stdout: "", stderr: "" };
      }
      case "find-generic-password": {
        const code = fail.read?.(account);
        if (code !== undefined) return { code, stdout: "", stderr: "" };
        const v = items.get(key);
        if (!v) return { code: 44, stdout: "", stderr: "" };
        if (!args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        const printable = [...v].every((b) => b >= 0x20 && b < 0x7f);
        return { code: 0, stdout: (printable ? v.toString("latin1") : v.toString("hex")) + "\n", stderr: "" };
      }
      case "delete-generic-password":
        return items.delete(key) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const run: RunFn = async (argv, _timeout, options) => {
    if (argv[0] !== "security") return { code: 127, stdout: "", stderr: "" };
    if (argv[1] !== "-i") return one(argv.slice(1));
    let last = { code: 0, stdout: "", stderr: "" };
    for (const line of (options?.stdin ?? "").split("\n").filter(Boolean)) last = one(line.split(" "));
    return last;
  };
  const has = (account: string) => items.has(`pacer|${account}`);
  return { run, items, accounts, fail, has };
}
