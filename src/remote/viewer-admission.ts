import type { Socket } from "node:net";

/** Reserve a remote viewer before exposing the socket to a client. */
export async function admitRemoteViewer(socket: Socket): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let reply = Buffer.alloc(0);
    const timer = setTimeout(() => finish(Error("remote viewer admission timed out")), 2000);
    const finish = (error?: Error, reply?: string) => {
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("error", failed);
      socket.off("close", closed);
      if (error) reject(error);
      else if (reply === "PACER-READY\n") resolve(null);
      else if (reply?.startsWith("PACER-REFUSED ")) resolve(reply.slice(14).trim());
      else reject(Error("invalid remote viewer admission"));
    };
    const data = (bytes: Buffer) => {
      reply = Buffer.concat([reply, bytes]);
      if (reply.length > 1024) finish(Error("remote viewer admission response too large"));
      else {
        const end = reply.indexOf(10);
        if (end >= 0) {
          socket.pause();
          if (end + 1 < reply.length) socket.unshift(reply.subarray(end + 1));
          finish(undefined, reply.subarray(0, end + 1).toString());
        }
      }
    };
    const failed = (error: Error) => finish(error);
    const closed = () => finish(Error("remote viewer socket closed"));
    socket.on("data", data);
    socket.once("error", failed);
    socket.once("close", closed);
    socket.write("PACER-VIEWER/1\n");
    socket.resume();
  });
}
