/** Own both probe ports before the service starts; never forward requests. */
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";

const ports = process.argv[2].split(",").map(Number);
const modes = (process.argv[4] ?? "ollama=fail,lmstudio=fail").split(",").map(part => part.split("=")[1]);
const models = [{ id: "fixture-alpha", name: "fixture-alpha" }, { id: "fixture-beta", name: "fixture-beta" }];
const servers = ports.map((_, index) => createServer(socket => {
  const mode = modes[index];
  if (mode.startsWith("fail")) {
    const delay = Number(mode.split(":")[1] ?? 0);
    if (delay) setTimeout(() => socket.destroy(), delay); else socket.destroy();
    return;
  }
  socket.once("data", data => {
    const path = data.toString().split(" ")[1];
    const body = path === "/v1/models" ? JSON.stringify({ data: models }) : path === "/api/tags" ? JSON.stringify({ models }) : "{}";
    const status = path === "/v1/models" || path === "/api/tags" ? "200 OK" : "404 Not Found";
    socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
}));
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
