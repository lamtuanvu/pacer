import { writeFileSync } from "node:fs";
export async function recordDispatch() {
  const proc = Bun.spawn(
    [
      process.execPath,
      new URL("../../test/fixtures/sessions/cli-branches.ts", import.meta.url)
        .pathname,
    ],
    { env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw Error(`CLI fixture failed: ${err}`);
  return JSON.parse(out);
}
if (import.meta.main)
  writeFileSync(
    new URL(
      "../../test/fixtures/sessions/dispatch-parity.json",
      import.meta.url,
    ),
    JSON.stringify(await recordDispatch(), null, 2) + "\n",
  );
