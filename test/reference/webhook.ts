interface Delivery {
  method: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64: string;
}

// The receiver and its captured requests belong to one reference run.
export function startReceiver() {
  const deliveries: Delivery[] = [];
  let responseStatus = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/deliver" && request.method === "POST") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        deliveries.push({
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: new TextDecoder().decode(bytes),
          bodyBase64: Buffer.from(bytes).toString("base64"),
        });
        return new Response(null, { status: responseStatus });
      }
      if (path === "/deliveries" && request.method === "GET") return Response.json(deliveries);
      if (path === "/deliveries" && request.method === "DELETE") {
        deliveries.length = 0;
        return new Response(null, { status: 204 });
      }
      if (path === "/status" && request.method === "PUT") {
        try {
          const input = (await request.json()) as { status?: unknown };
          if (
            typeof input.status !== "number" ||
            !Number.isInteger(input.status) ||
            input.status < 200 ||
            input.status > 599
          )
            throw new Error("invalid status");
          responseStatus = input.status;
          return Response.json({ status: responseStatus });
        } catch {
          return Response.json(
            { error: "status must be an integer from 200 to 599" },
            { status: 400 },
          );
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}
