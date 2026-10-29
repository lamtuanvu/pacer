import type { RunFn } from "../src/types";

/** A `security` stand-in keyed by service and account, shared by every home that uses it. */
export function fakeKeychain() {
  const items = new Map<string, Buffer>();
  const accounts = new Set<string>();
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];
  const one = (args: string[]) => {
    const key = `${flag(args, "-s")}|${flag(args, "-a")}`;
    switch (args[0]) {
      case "add-generic-password":
        accounts.add(flag(args, "-a"));
        items.set(key, Buffer.from(flag(args, "-X"), "hex"));
        return { code: 0, stdout: "", stderr: "" };
      case "find-generic-password": {
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
  return { run, items, accounts };
}
