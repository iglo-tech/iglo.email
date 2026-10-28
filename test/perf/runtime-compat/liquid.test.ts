// Specification for the synthetic HTTP renderer, not a production template API.
import { expect, test } from "bun:test";
import { startLiquidFixture } from "@/test/perf/runtime-compat/liquid-http";

async function withRenderer(run: (origin: string) => Promise<void>) {
  const fixture = startLiquidFixture();
  try {
    await run(fixture.origin);
  } finally {
    await fixture.close();
  }
}
async function render(origin: string, input: object) {
  const response = await fetch(`${origin}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(3000),
  });
  return {
    status: response.status,
    ...((await response.json()) as { result?: string; error?: string }),
  };
}

test("HTML values escape by default, raw is explicit, and text and subjects stay plain", async () => {
  await withRenderer(async (origin) => {
    const data = { subscriber: { name: `A<&\"'`, attribs: { city: "Łódź" } } };
    expect(
      await render(origin, {
        body: "{{ subscriber.name }} / {{ subscriber.name | raw }} / {{ subscriber.attribs.city }} / {{ subscriber.missing.deep }}",
        data,
      }),
    ).toEqual({
      status: 200,
      result: "A&lt;&amp;&#34;&#39; / A<&\"' / Łódź / ",
    });
    expect(
      await render(origin, { mode: "plain", body: "Subject {{ subscriber.name }}", data }),
    ).toEqual({ status: 200, result: `Subject A<&\"'` });
  });
});

test("layout inserts the already escaped rendered body once; hooks use only fixture data", async () => {
  await withRenderer(async (origin) => {
    const result = await render(origin, {
      body: "<p>{{ subscriber.name }}</p><a href=\"{{ url | track_link }}\">{{ 'hello' | t }}</a>",
      layout: "<main>{{ content | raw }}</main><footer>{{ campaign.name }}</footer>",
      data: {
        subscriber: { name: "A & B" },
        campaign: { name: "C < D" },
        url: "https://example.test/?a=1&b=2",
      },
    });
    expect(result).toEqual({
      status: 200,
      result:
        '<main><p>A &amp; B</p><a href="https://example.test/?a=1&amp;b=2&amp;fixture=1">Hello</a></main><footer>C &lt; D</footer>',
    });
  });
});

test("own properties are visible, inherited properties are hidden and missing values are empty", async () => {
  await withRenderer(async (origin) => {
    expect(await render(origin, { action: "prototype" })).toEqual({
      status: 200,
      result: "visible||",
    });
  });
});

test("include, render and layout cannot resolve fixture-external files or URLs", async () => {
  await withRenderer(async (origin) => {
    for (const tag of ["include", "render", "layout"]) {
      for (const target of ["/fixture-canary.txt", "https://example.test/canary"]) {
        const response = await render(origin, { body: `{% ${tag} '${target}' %}` });
        expect(response.status).toBe(400);
        expect(response.error).toContain("ENOENT");
      }
    }
  });
});

test("parse and operation-allocation limits reject bounded examples", async () => {
  await withRenderer(async (origin) => {
    const parse = await render(origin, { limit: "small-parse", body: "x".repeat(129) });
    expect(parse.status).toBe(400);
    expect(parse.error).toContain("parse length limit exceeded");
    const memory = await render(origin, {
      limit: "small-memory",
      body: "{% for x in (1..100) %}x{% endfor %}",
    });
    expect(memory.status).toBe(400);
    expect(memory.error).toContain("memory alloc limit exceeded");
  });
});
