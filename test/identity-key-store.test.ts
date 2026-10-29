import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { homeTag, keyBackend, readPrivateKey, writePrivateKey, deletePrivateKey } from "../src/identity/key-store";

test("backend is keychain on darwin and file elsewhere", () => {
  expect(keyBackend("darwin")).toBe("keychain");
  expect(keyBackend("linux")).toBe("file");
});

test("file backend stores PKCS8 at identity/machine.key with 0600", async () => {
  const ctx = fakeCtx();
  const { privateKey } = generateKeyPairSync("ed25519");
  expect(await readPrivateKey(ctx, "file")).toBeNull();
  await writePrivateKey(ctx, "file", privateKey);
  const path = join(ctx.pacerHome, "identity", "machine.key");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const back = await readPrivateKey(ctx, "file");
  expect(back!.export({ format: "der", type: "pkcs8" })).toEqual(privateKey.export({ format: "der", type: "pkcs8" }));
  await deletePrivateKey(ctx, "file");
  expect(await readPrivateKey(ctx, "file")).toBeNull();
});

test("keychain backend never puts the key in argv and uses service pacer, account machine-identity/<homeTag>", async () => {
  const store = new Map<string, string>();
  const calls: string[][] = [];
  const ctx = fakeCtx({
    run: async (argv: string[], timeout: number, options?: { stdin?: string }) => {
      calls.push(argv);
      const account = `machine-identity/${homeTag(ctx)}`;
      if (argv[1] !== "-i") expect(argv.slice(argv.indexOf("-a"), argv.indexOf("-a") + 2)).toEqual(["-a", account]);
      expect(argv[0]).toBe("security");
      expect(timeout).toBe(10000);
      if (argv[1] === "-i") {
        const m = new RegExp(`^add-generic-password -U -s pacer -a ${account} -X ([0-9a-f]+)\n$`).exec(options!.stdin!);
        if (m) store.set("machine-identity", m[1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[1] === "find-generic-password") {
        const hex = store.get("machine-identity");
        if (!hex) return { code: 44, stdout: "", stderr: "" };
        return { code: 0, stdout: argv.includes("-w") ? Buffer.from(hex, "hex").toString("hex") + "\n" : "", stderr: "" };
      }
      if (argv[1] === "delete-generic-password") { store.delete("machine-identity"); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("hex");
  await writePrivateKey(ctx, "keychain", privateKey);
  expect(calls.flat().join(" ")).not.toContain(der);
  const back = await readPrivateKey(ctx, "keychain");
  expect(back!.export({ format: "der", type: "pkcs8" }).toString("hex")).toBe(der);
  await deletePrivateKey(ctx, "keychain");
  expect(await readPrivateKey(ctx, "keychain")).toBeNull();
});
