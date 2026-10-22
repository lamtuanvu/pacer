import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { tmpDir } from "./helpers";

const cli = resolve(import.meta.dir, "../scripts/live/cli.ts");

for (const command of ["doctor", "targets", "inspect", "act", "wait", "assert", "capture", "scenario"]) {
  test(`live ${command} reaches the structured control dispatcher without requesting OS access`, async () => {
    const home = tmpDir();
    const child = Bun.spawn([process.execPath, cli, command, "--id", `routing-missing-${crypto.randomUUID()}`, "--json", ...(command === "doctor" ? ["--surface", "desktop"] : [])], {
      env: { ...process.env, HOME: home, PACER_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(errors).toBe("");
    const result = JSON.parse(output);
    expect(result.schema_version).toBe(1);
    expect(result.command).toBe(command);
    expect(result.outcome).toBe("error");
    expect(result.artifacts).toEqual([]);
    expect(result.error.code).toBe("invalid_input");
    if (command === "doctor") expect(result.error.message).toContain("ENOENT");
  });
}
