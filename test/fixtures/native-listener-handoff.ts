import { closeSync, fstatSync } from "node:fs";
import { LocalNativeServer, receiveParentListener } from "../../src/update/desktop/native-socket";
import { processIdentity } from "../../src/update/desktop/process-identity";

try {
  const adoption = process.argv[2] === "adopt";
  const owner = adoption ? processIdentity(process.ppid) : null;
  if (adoption) process.stdout.write(JSON.stringify({ phase: "owner", owner }) + "\n");
  const fd = receiveParentListener();
  if (adoption) {
    if (!owner) { closeSync(fd); throw Error("Parent identity unavailable"); }
    let finish!: (pid: number) => void;
    const completed = new Promise<number>(resolve => { finish = resolve; });
    const server = new LocalNativeServer(process.argv[3]!, peer => {
      const pid = new DataView(peer.auditToken.buffer).getUint32(20, true);
      peer.onFrame = frame => {
        if (JSON.stringify(frame) !== JSON.stringify({ ping: true })) { peer.close(); return; }
        void peer.send({ pid }).then(() => finish(pid));
      };
    }, { fd, owner });
    process.stdin.resume();
    process.stdout.write(JSON.stringify({ phase: "listening" }) + "\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const peerPid = await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Client timed out")), 3000); })]);
      server.close();
      process.stdout.write(JSON.stringify({ accepted: true, peerPid }) + "\n");
    } finally { clearTimeout(timer); server.close(); process.stdin.pause(); }
    process.exit(0);
  }
  let socket: boolean;
  try {
    const stat = fstatSync(fd);
    socket = stat.isSocket();
  } finally { closeSync(fd); }
  if (process.argv[2] === "leak") {
    const count = () => {
      let total = 0;
      for (let n = 0; n < 512; n++) { try { fstatSync(n); total++; } catch {} }
      return total;
    };
    const before = count();
    for (let n = 0; n < 50; n++) {
      let rejected = false;
      try { const unexpected = receiveParentListener(); closeSync(unexpected); }
      catch { rejected = true; }
      if (!rejected) throw Error("Malformed transfer accepted");
    }
    if (count() !== before) throw Error("Malformed transfer leaked descriptors");
  }
  process.stdout.write(JSON.stringify({ accepted: true, socket }) + "\n");
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.stdout.write(JSON.stringify({ accepted: false }) + "\n");
}
