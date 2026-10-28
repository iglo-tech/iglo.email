// D18/D38 transport observation with invocation-owned local requests.
import { createConnection } from "node:net";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return Response.json({ pathname: new URL(request.url).pathname });
  },
});
try {
  for (const [wirePath, expected] of [
    ["/api/subscribers/external/%2E", "/api/subscribers/external/"],
    ["/api/subscribers/external/%2E%2E", "/api/subscribers/"],
  ]) {
    const socket = createConnection({ host: "127.0.0.1", port: server.port! });
    const result = new Promise<string>((resolve, reject) => {
      let response = "";
      socket.on("data", (part) => (response += part.toString()));
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    socket.end(
      `GET ${wirePath} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
    );
    const response = await result;
    const body = response.slice(response.indexOf("\r\n\r\n") + 4);
    const actual = JSON.parse(body).pathname;
    if (actual !== expected) throw new Error(`Unexpected normalized path for ${wirePath}`);
    process.stdout.write(`${wirePath} -> ${actual}\n`);
  }
} finally {
  await server.stop(true);
}
