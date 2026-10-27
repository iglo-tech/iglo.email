// Synthetic process used to exercise a nonzero shutdown through the public HTTP boundary.
const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () => new Response('{"data":true}\n', { headers: { "content-type": "application/json" } }),
});
process.once("SIGTERM", () => process.exit(42));
