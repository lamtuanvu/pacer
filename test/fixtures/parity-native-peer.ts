export {};
for await (const line of Bun.stdin.stream()) {
  const request = JSON.parse(new TextDecoder().decode(line));
  const result = request.method === "hello" ? JSON.parse(process.env.PACER_TEST_HELLO ?? "{}") : request.params ?? {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
