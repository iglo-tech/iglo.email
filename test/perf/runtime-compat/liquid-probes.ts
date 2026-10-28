// Bounded adversarial probes; run in a separate source or compiled process.
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { engine } from "@/test/perf/runtime-compat/liquid-render";
import { startLiquidFixture } from "@/test/perf/runtime-compat/liquid-http";

export async function probeLiquid() {
  const parse = engine("plain", { parseLimit: 4 });
  assert.equal(parse.parseAndRenderSync("😀😀"), "😀😀");
  assert.throws(() => parse.parse("😀😀x"), /parse length limit exceeded/);
  const boundedMemory = engine("plain", { memoryLimit: 10 });
  assert.throws(
    () => boundedMemory.parseAndRenderSync("{% for n in (1..100) %}x{% endfor %}"),
    /memory alloc limit exceeded/,
  );
  const output = boundedMemory.parseAndRenderSync("{{ value | raw }}", { value: "x".repeat(4096) });
  assert.equal(output.length, 4096);

  let finishedFilter = false;
  const timed = engine("plain", { renderLimit: 5 });
  timed.registerFilter("bounded_delay", (value: string) => {
    const start = performance.now();
    while (performance.now() - start < 50) {
      /* Deliberately block a trusted synthetic filter. */
    }
    finishedFilter = true;
    return value;
  });
  const start = performance.now();
  assert.throws(
    () => timed.parseAndRenderSync('{{ "x" | bounded_delay }}!'),
    /template render limit exceeded/,
  );
  const blockedMs = performance.now() - start;
  assert.ok(finishedFilter, "render limit unexpectedly interrupted the running filter");

  const array: string[] = [];
  array.length = 1;
  Object.setPrototypeOf(
    array,
    Object.assign(Object.create(Array.prototype), { 0: "inherited-fixture" }),
  );
  const inherited = engine("plain").parseAndRenderSync(
    "{{ arr[0] }}|{% for item in arr %}{{ item }}{% endfor %}",
    { arr: array },
  );
  const canary = join(process.cwd(), "fixture-canary.txt");
  await writeFile(canary, "synthetic-canary-only");
  let requests = 0;
  const trap = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response("synthetic-network-canary");
    },
  });
  try {
    const denied = engine("plain");
    for (const tag of ["include", "render", "layout"]) {
      for (const target of [
        canary,
        `http://127.0.0.1:${trap.port}/fixture`,
        "constructor",
        "toString",
        "__proto__",
      ]) {
        await assert.rejects(denied.parseAndRender(`{% ${tag} '${target}' %}`), /ENOENT/);
      }
    }
    assert.equal(requests, 0);
    const http = startLiquidFixture();
    try {
      const response = await fetch(`${http.origin}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "<p>{{ subscriber.name }}</p>",
          layout: "<main>{{ content | raw }}</main>",
          data: { subscriber: { name: "A & B" } },
        }),
      });
      assert.deepEqual(await response.json(), { result: "<main><p>A &amp; B</p></main>" });
    } finally {
      await http.close();
    }
    return {
      parseLimit: "UTF-16 code units: 4 pass, 5 reject",
      memoryLimit: "range allocation rejected; 4096 output characters bypassed limit 10",
      renderLimit: "5ms limit reported only after 50ms filter completed",
      observedBlockedMs: Number(blockedMs.toFixed(3)),
      inheritedArray: inherited,
      fileAndUrlTags: "denied",
      trapRequests: requests,
      http: "escaped layout passed",
    };
  } finally {
    await trap.stop(true);
    await rm(canary, { force: true });
  }
}
if (import.meta.main) console.log(JSON.stringify(await probeLiquid()));
