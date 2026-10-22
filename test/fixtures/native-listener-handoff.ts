import { closeSync, fstatSync } from "node:fs";
import { receiveParentListener } from "../../src/update/desktop/native-socket";

try {
  const fd = receiveParentListener();
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
