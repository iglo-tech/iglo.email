// Test-only HTTP caller of the production renderer, including file and loopback traps.
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRenderer } from "@/templates/renderer";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";

const renderer = createRenderer(createRealClock(), createTranslation());
const canary = join(process.cwd(), "template-canary.txt");
await writeFile(canary, "synthetic-file-canary");
let requests = 0;
const trap = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    requests++;
    return new Response("synthetic-network-canary");
  },
});
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const value = (await request.json()) as { body: string; data: unknown; layout?: string };
    try {
      return new Response(
        (
          await renderer.render({
            body: value.body,
            data: value.data,
            mode: "html",
            ...(value.layout === undefined ? {} : { layout: value.layout }),
          })
        ).body,
      );
    } catch {
      return new Response("invalid", { status: 400 });
    }
  },
});
try {
  const send = (body: string, data: unknown = {}, layout?: string) =>
    fetch(fixture.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, data, layout }),
    });
  assert.equal(
    await (
      await send("<p>{{ name }}</p>", { name: "A & B" }, "<main>{{ content | raw }}</main>")
    ).text(),
    "<main><p>A &amp; B</p></main>",
  );
  for (const tag of ["include", "render", "layout"])
    for (const name of [
      canary,
      `http://127.0.0.1:${trap.port}/`,
      "constructor",
      "toString",
      "__proto__",
    ]) {
      const response = await send(`{% ${tag} '${name}' %}`);
      const body = await response.text();
      assert.equal(response.status, 400);
      assert.ok(
        !body.includes("synthetic-file-canary") && !body.includes("synthetic-network-canary"),
      );
    }
  assert.equal(requests, 0);
  assert.equal((await send("{{ value[key] }}", { value: {}, key: ["constructor"] })).status, 400);
  assert.equal(
    (
      await send("{% for n in (1..500) %}{% if hay contains 'z' %}{% endif %}{% endfor %}", {
        hay: "a".repeat(65536),
      })
    ).status,
    400,
  );

  const values: Record<string, number> = {};
  for (let i = 0; i < 1024; i++) values[`k${i}`] = i;
  assert.equal(
    (
      await send(
        "{% for i in (1..1000) %}{% for pair in values limit: 0 %}{% endfor %}{% endfor %}",
        { values },
      )
    ).status,
    400,
  );

  assert.equal(
    (await send(`{% if ${"x or ".repeat(10001)}x %}never{% endif %}`, { x: false })).status,
    400,
  );
  assert.equal((await send("{% for x in (1..1025) %}x{% endfor %}")).status, 400);
  assert.equal(
    (await send("{% for x in (9007199254740992..9007199254740994) %}x{% endfor %}")).status,
    400,
  );
  assert.equal(
    (
      await send(
        "{% capture x %}{% for i in (1..1024) %}{{ value }}{% endfor %}{% endcapture %}{{ x }}",
        { value: "x".repeat(2048) },
      )
    ).status,
    400,
  );
  process.stdout.write("compiled renderer fixture passed\n");
} finally {
  await fixture.stop(true);
  await trap.stop(true);
  await rm(canary, { force: true });
}
