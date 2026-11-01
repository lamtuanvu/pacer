import { join } from "node:path";
import { healthy, pacerArgv, record, sandboxEnv, type Session } from "./core";

type Reply = { id?: number; result?: unknown; error?: unknown };

export function verifyNativeStdio(stdout: string, stderr: string, exit: number): void {
  if (exit !== 0) throw Error(`native stdio exited ${exit}: ${stderr}`);
  const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Reply);
  if (replies.length !== 3 || replies[0]?.id !== 1 || replies[1]?.id !== 2 || replies[2]?.id !== 3) {
    throw Error("native stdio returned unexpected reply IDs");
  }
  if ((replies[0].result as { protocol?: string } | undefined)?.protocol !== "3.0.0") throw Error("native stdio did not negotiate protocol 3");
  if (JSON.stringify(replies[1].result) !== JSON.stringify({ fixture: "native-stdio", n: 1 })) throw Error("native stdio echo result differed");
  if ((replies[2].result as { protocol?: string } | undefined)?.protocol !== "2.8.0") throw Error("native stdio did not negotiate protocol 2");
  const markers = stderr.split("\n").filter(line => line.startsWith("native test.echo"));
  if (markers.length !== 1 || markers[0] !== "native test.echo 2") {
    throw Error("native stdio execution trace was absent or repeated");
  }
}

/** Fixed protocol exchange inside an owned sandbox; the ordinary D3 CLI guard remains in force. */
export async function exerciseNativeStdio(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !session.nativeTestOps || session.nativeForwardEcho || session.realKeychain || session.stopped) {
    throw Error("native stdio requires an active sandbox Rust test-ops build without forwarding or real Keychain");
  }
  if (!await healthy(session)) throw Error("native stdio requires a healthy guarded sandbox");
  const argv = [...pacerArgv(session), "api", "--stdio"];
  const env = { ...sandboxEnv(session), HOME: join(session.root, "home"), PACER_NO_SELF_REPAIR: "1" };
  const child = Bun.spawn(argv, { cwd: join(session.root, "repo"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const input = [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: 2, method: "test.echo", params: { fixture: "native-stdio", n: 1 } },
    { jsonrpc: "2.0", id: 3, method: "hello", params: { protocol: 2 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  await child.stdin.write(input);
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  record(session, { kind: "command", argv, code, stdout, stderr });
  try {
    verifyNativeStdio(stdout, stderr, code);
    record(session, { kind: "note", behavior: "Protocol-3 native stdio dispatch", surface: "stdio API", verdict: "PASS",
      steps: "Fixed hello(3), test.echo, hello(2) exchange in the owned sandbox", text: "Protocol 3 accepted, test.echo returned exact fixture payload once, native trace recorded, protocol 2 accepted." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Protocol-3 native stdio dispatch", surface: "stdio API", verdict: "FAIL", text: (error as Error).message });
    throw error;
  }
}
