/** Own both probe ports before the service starts; never forward requests. */
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";

const ports = process.argv[2].split(",").map(Number);
const servers = ports.map(() => createServer(socket => socket.destroy()));
try {
  for (const [index, server] of servers.entries()) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ports[index], "127.0.0.1", resolve);
    });
  }
  writeFileSync(process.argv[3], "ready\n", { flag: "wx", mode: 0o600 });
} catch (error) {
  console.error(error);
  for (const server of servers) server.close();
  writeFileSync(process.argv[3] + ".error", "bind failed\n", { flag: "wx", mode: 0o600 });
  // Remain alive until the harness can verify and stop the process group.
  setInterval(() => {}, 1000);
}
