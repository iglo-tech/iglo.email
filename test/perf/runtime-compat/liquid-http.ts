// Test-only loopback HTTP boundary for explicitly supplied or generated data.
import { render, type FixtureInput } from "@/test/perf/runtime-compat/liquid-render";

export function startLiquidFixture() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/render")
        return new Response("Not found", { status: 404 });
      try {
        const input = (await request.json()) as FixtureInput & { action?: string };
        if (input.action === "prototype-array") {
          const array: string[] = [];
          array.length = 1;
          Object.setPrototypeOf(
            array,
            Object.assign(Object.create(Array.prototype), { 0: "inherited-fixture" }),
          );
          return Response.json({
            result: render({
              mode: "plain",
              body: "{{ arr[0] }}|{% for item in arr %}{{ item }}{% endfor %}",
              data: { arr: array },
            }),
          });
        }
        if (input.action === "prototype") {
          const subscriber = Object.assign(Object.create({ hidden: "secret" }), {
            visible: "visible",
          });
          return Response.json({
            result: render({
              body: "{{ subscriber.visible }}|{{ subscriber.hidden }}|{{ subscriber.constructor }}",
              data: { subscriber },
            }),
          });
        }
        if (typeof input.body !== "string" || input.body.length > 65536)
          throw new Error("Invalid synthetic template");
        return Response.json({ result: render(input) });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}
