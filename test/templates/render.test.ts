// D23/D54 renderer behavior through a test-only HTTP caller; no production debug route.
import { describe, expect, test } from "bun:test";
import { createRenderer } from "@/templates/renderer";
import { createRealClock } from "@/clock";
import { createTranslation, Translation } from "@/i18n/i18n";
import { TestClock } from "@/test/server/fixture";
import { initialTemplates, systemTemplates } from "@/templates/builtins";

function caller() {
  const renderer = createRenderer(createRealClock(), createTranslation());
  return async (body: string, data: unknown, mode: "html" | "plain" = "html", layout?: string) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        try {
          return new Response(
            (
              await renderer.render({
                body,
                data,
                mode,
                ...(layout === undefined ? {} : { layout }),
              })
            ).body,
          );
        } catch {
          return new Response("invalid", { status: 400 });
        }
      },
    });
    try {
      return await fetch(server.url);
    } finally {
      await server.stop(true);
    }
  };
}

describe("bounded Liquid caller", () => {
  test("escapes HTML, supports raw and composes the body once", async () => {
    const call = caller();
    expect(
      await (
        await call(
          "{{ name }} {{ name | raw }}",
          { name: "<b>&</b>" },
          "html",
          "<main>{{ content | raw }}</main>",
        )
      ).text(),
    ).toBe("<main>&lt;b&gt;&amp;&lt;/b&gt; <b>&</b></main>");
    expect(await (await call("{{ name }}", { name: "<b>&</b>" }, "plain")).text()).toBe("<b>&</b>");
  });
  test("accessors and cycles fail without invoking getters", async () => {
    const call = caller();
    let invoked = false;
    const input = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        invoked = true;
        return "secret";
      },
    });
    expect((await call("{{ x }}", input)).status).toBe(400);
    expect(invoked).toBe(false);
    const hidden = Object.defineProperty({}, "hidden", {
      get() {
        invoked = true;
        return "secret";
      },
    });
    expect((await call("hello", hidden)).status).toBe(400);
    expect(invoked).toBe(false);
    let trapped = false;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          trapped = true;
          return Object.prototype;
        },
      },
    );
    expect((await call("hello", proxy)).status).toBe(400);
    expect(trapped).toBe(false);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect((await call("{{ self }}", cycle)).status).toBe(400);
  });
  test("nested captures, ranges, lookup and output are bounded", async () => {
    const call = caller();
    expect((await call("{% for i in (1..1025) %}x{% endfor %}", {})).status).toBe(400);
    expect((await call('{% include "constructor" %}', {})).status).toBe(400);
    expect(
      (await call("{% for i in (1..1024) %}{{ x }}{% endfor %}", { x: "x".repeat(2048) })).status,
    ).toBe(400);
    expect(
      (
        await call(
          "{% capture x %}{% for i in (1..1024) %}{{ v }}{% endfor %}{% endcapture %}{{ x }}",
          { v: "x".repeat(2048) },
        )
      ).status,
    ).toBe(400);
  });
});

test("UTF-8 bounds and explicit raw output", async () => {
  const call = caller();
  expect((await call("😀".repeat(16384), {})).status).toBe(200);
  expect((await call("😀".repeat(16384) + "x", {})).status).toBe(400);
  const body = "{% for i in (1..16) %}{{ value | raw }}{% endfor %}";
  const exactly = await call(body, { value: "x".repeat(65536) });
  expect(exactly.status).toBe(200);
  expect((await exactly.text()).length).toBe(1024 * 1024);
  expect((await call(body.replace("1..16", "1..17"), { value: "x".repeat(65536) })).status).toBe(
    400,
  );
});

test("plain data rejects callable, class, non-finite and magic properties", async () => {
  const call = caller();
  for (const value of [
    () => "called",
    new Date(),
    NaN,
    Infinity,
    JSON.parse('{"constructor":"canary"}'),
  ]) {
    expect((await call("{{ x }}", { x: value })).status).toBe(400);
  }
  const array: unknown[] = [];
  array.length = 2;
  array[1] = "own";
  expect(await (await call("{% for x in xs %}{{ x }}{% endfor %}", { xs: array })).text()).toBe(
    "own",
  );
});

test("range rejects unsafe integer endpoints and unsupported capabilities", async () => {
  const call = caller();
  expect(
    (await call("{% for n in (9007199254740992..9007199254740994) %}x{% endfor %}", {})).status,
  ).toBe(400);
  for (const name of [
    "constructor",
    "__proto__",
    "toString",
    "/etc/passwd",
    "http://127.0.0.1:1/trap",
  ]) {
    expect((await call(`{% render '${name}' %}`, {})).status).toBe(400);
  }
  expect((await call("{{ x | replace: 'a', 'b' }}", { x: "a" })).status).toBe(400);
});

test("built-ins render synthetic semantic content and clock stays instance-owned", async () => {
  const clock = new TestClock();
  const renderer = createRenderer(clock, createTranslation());
  const fixture = {
    logo_url: "https://example.invalid/logo.png",
    root_url: "https://example.invalid",
    reset_url: "https://example.invalid/reset",
    optin_url: "https://example.invalid/confirm",
    manage_url: "https://example.invalid/manage",
    subscriber: { name: "A & B", first_name: "Ada" },
    campaign: { subject: "Synthetic" },
    data: { order_id: "1234", shipping_date: "tomorrow" },
    lists: [{ type: "public", name: "Synthetic List" }],
    name: "Synthetic import",
    status: "finished",
    id: 1,
    sent: 2,
    to_send: 3,
    reason: "",
    imported: 2,
    total: 3,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/date")
        return new Response(
          (
            await renderer.render({
              body: '{{ "now" | date: "%Y-%m-%d %H:%M:%S" }}',
              mode: "plain",
              data: fixture,
            })
          ).body,
        );
      if (path.startsWith("/initial/")) {
        const item = initialTemplates[Number(path.slice("/initial/".length))]!;
        const result = await renderer.render(
          item.type === "campaign"
            ? { body: "<p>Hi</p>", layout: item.body, mode: "html", data: fixture }
            : {
                body: item.body,
                subject: item.subject,
                mode: "html",
                data: fixture,
                transactional: true,
              },
        );
        return new Response(result.body);
      }
      const name = path.slice(1) as keyof typeof systemTemplates;
      return new Response(
        (await renderer.render({ body: systemTemplates[name], mode: "html", data: fixture })).body,
      );
    },
  });
  try {
    const first = await (await fetch(new URL("/date", server.url))).text();
    clock.advance(86_400_000);
    expect(first).toBe("2026-01-02 03:04:05");
    expect(await (await fetch(new URL("/date", server.url))).text()).toBe("2026-01-03 03:04:05");
    for (const [name, expected] of Object.entries({
      campaignStatus: "Synthetic",
      importStatus: "Synthetic import",
      forgotPassword: "https://example.invalid/reset",
      subscriberData: "<h2>",
      subscriberOptin: "Synthetic List",
      subscriberOptinCampaign: "Synthetic List",
      smtpTest: "<h2>",
    })) {
      const response = await fetch(new URL(`/${name}`, server.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(expected);
    }
    for (let index = 0; index < initialTemplates.length; index++) {
      const response = await fetch(new URL(`/initial/${index}`, server.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        initialTemplates[index]!.type === "campaign" ? "<p>Hi</p>" : "1234",
      );
    }
  } finally {
    await server.stop(true);
  }
});

test("admission releases after success and error and is instance scoped", async () => {
  const first = createRenderer(createRealClock(), createTranslation());
  const second = createRenderer(createRealClock(), createTranslation());
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      const input = { body: "hello", data: {}, mode: "plain" as const };
      const results = await Promise.allSettled([
        first.render(input),
        first.render(input),
        first.render(input),
        first.render(input),
        first.render(input),
        second.render(input),
      ]);
      const error = await Promise.allSettled([
        first.render({ ...input, body: '{% include "no" %}' }),
      ]);
      const recovered = await first.render(input);
      return Response.json({
        statuses: results.map((result) => result.status),
        failed: error[0]?.status,
        recovered: recovered.body,
      });
    },
  });
  try {
    expect(await (await fetch(server.url)).json()).toEqual({
      statuses: ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"],
      failed: "rejected",
      recovered: "hello",
    });
  } finally {
    await server.stop(true);
  }
});

test("compiled snapshots retain their source and sanitize data for every caller", async () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  const input = {
    body: "<p>{{ name }}</p>",
    layout: "<main>{{ content | raw }}</main>",
    mode: "html" as const,
  };
  const compiled = renderer.compile(input);
  input.body = "changed";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const data = await request.json();
      return new Response((await compiled.render(data)).body);
    },
  });
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A & B" }),
    });
    expect(await response.text()).toBe("<main><p>A &amp; B</p></main>");
  } finally {
    await server.stop(true);
  }
});

test("UTF-8 output and data bounds, tracking and URL contexts", async () => {
  const call = caller();
  const body = "{% for i in (1..16) %}{{ value | raw }}{% endfor %}";
  const exact = await call(body, { value: "😀".repeat(16384) });
  expect(exact.status).toBe(200);
  expect(Buffer.byteLength(await exact.text())).toBe(1024 * 1024);
  expect((await call(body.replace("1..16", "1..17"), { value: "😀".repeat(16384) })).status).toBe(
    400,
  );
  expect((await call("{{ value }}", { value: "😀".repeat(16384) + "a" })).status).toBe(400);
  expect(
    (await call("{% for x in xs %}{{ x }}{% endfor %}", { xs: Array(1025).fill("a") })).status,
  ).toBe(400);
  expect(
    await (
      await call('<a href="{{ link | track_link }}">link</a>', {
        link: "https://example.invalid/path?a=1&b=2",
      })
    ).text(),
  ).toBe('<a href="https://example.invalid/path?a=1&amp;b=2">link</a>');
  expect((await call("{{ link | track_link }}", { link: "javascript:alert(1)" })).status).toBe(400);
  expect((await call("{{ logo_url }}", { logo_url: "javascript:alert(1)" })).status).toBe(400);
  // Escaping is not a general URL-context sanitizer for arbitrary author variables.
  expect(
    await (await call('<a href="{{ link }}">x</a>', { link: "javascript:alert(1)" })).text(),
  ).toBe('<a href="javascript:alert(1)">x</a>');
});

test("translation arguments are finite and instance-local", async () => {
  const call = caller();
  expect(
    await (
      await call('{{ "globals.messages.invalidFields" | t: "name", "Synthetic" }}', {})
    ).text(),
  ).toBe("Invalid fields: Synthetic");
  expect((await call('{{ "globals.messages.invalidFields" | t: "name" }}', {})).status).toBe(400);
  expect(
    (await call('{{ "globals.messages.invalidFields" | t: "name", v }}', { v: "x".repeat(1025) }))
      .status,
  ).toBe(400);
});

test("long expression work is charged even without output", async () => {
  const call = caller();
  const body = `{% if ${"x or ".repeat(10001)}x %}not emitted{% endif %}`;
  expect(Buffer.byteLength(body)).toBeLessThan(65536);
  expect((await call(body, { x: false }, "plain")).status).toBe(400);
});

test("asynchronous render captures source and caller data before yielding", async () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      const data = { name: "first" };
      const input = { body: "{{ name }}", data, mode: "plain" as const };
      const pending = renderer.render(input);
      input.body = "changed";
      data.name = "second";
      return new Response((await pending).body);
    },
  });
  try {
    expect(await (await fetch(server.url)).text()).toBe("first");
  } finally {
    await server.stop(true);
  }
});

test("inherited sparse-array indices are omitted without evaluating their getters", async () => {
  const call = caller();
  let invoked = false;
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "0", {
    get() {
      invoked = true;
      return "inherited-canary";
    },
  });
  const input: unknown[] = [];
  input.length = 2;
  input[1] = "own";
  Object.setPrototypeOf(input, prototype);
  const response = await call("{% for item in items %}{{ item }}{% endfor %}", { items: input });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("own");
  expect(invoked).toBe(false);
  class TaggedArray extends Array<string> {}
  expect((await call("{{ items }}", { items: new TaggedArray("x") })).status).toBe(400);
});

test("iterating large objects charges conversion even when limit is zero", async () => {
  const call = caller();
  const data: Record<string, number> = {};
  for (let index = 0; index < 1024; index++) data[`k${index}`] = index;
  const body = "{% for i in (1..1000) %}{% for pair in values limit: 0 %}{% endfor %}{% endfor %}";
  expect((await call(body, { values: data }, "plain")).status).toBe(400);
});

test("encoded context and rendered subject use UTF-8 byte boundaries", async () => {
  const call = caller();
  const chunk = "x".repeat(65536),
    data = { a: chunk, b: chunk, c: chunk, d: "" };
  data.d = "x".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(data)));
  expect(Buffer.byteLength(JSON.stringify(data))).toBe(256 * 1024);
  expect((await call("ok", data, "plain")).status).toBe(200);
  data.d += "x";
  expect((await call("ok", data, "plain")).status).toBe(400);
  const renderer = createRenderer(createRealClock(), createTranslation());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { value } = (await request.json()) as { value: string };
      try {
        return new Response(
          (
            await renderer.render({
              body: "",
              subject: "{{ value }}",
              mode: "plain",
              data: { value },
            })
          ).subject,
        );
      } catch {
        return new Response("invalid", { status: 400 });
      }
    },
  });
  try {
    const post = (value: string) =>
      fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    const exact = await post("é".repeat(1024));
    expect(exact.status).toBe(200);
    expect(Buffer.byteLength(await exact.text())).toBe(2048);
    expect((await post("é".repeat(1024) + "x")).status).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("independent renderers keep translation and clock state separate", async () => {
  const firstClock = new TestClock(),
    secondClock = new TestClock();
  secondClock.advance(86400000);
  const first = createRenderer(
    firstClock,
    new Translation({ "_.code": "a", "_.name": "A", fixture: "First" }),
  );
  const second = createRenderer(
    secondClock,
    new Translation({ "_.code": "b", "_.name": "B", fixture: "Second" }),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      const request = {
        body: '{{ "fixture" | t }} {{ "now" | date: "%Y-%m-%d" }}',
        mode: "plain" as const,
        data: {},
      };
      const values = await Promise.all([first.render(request), second.render(request)]);
      return Response.json(values.map((value) => value.body));
    },
  });
  try {
    expect(await (await fetch(server.url)).json()).toEqual([
      "First 2026-01-02",
      "Second 2026-01-03",
    ]);
  } finally {
    await server.stop(true);
  }
});

test("computed prototype names cannot be smuggled through array keys", async () => {
  const call = caller();
  expect(
    (await call("{{ value[key] }}", { value: {}, key: ["constructor"] }, "plain")).status,
  ).toBe(400);
});

test("repeated long contains operations consume finite text work", async () => {
  const call = caller();
  const body = "{% for n in (1..500) %}{% if hay contains 'z' %}{% endif %}{% endfor %}";
  expect((await call(body, { hay: "a".repeat(65536) }, "plain")).status).toBe(400);
});

test("captures share one cumulative emission budget", async () => {
  const call = caller();
  const capture =
    "{% capture x %}{% for n in (1..16) %}{{ value | raw }}{% endfor %}{% endcapture %}";
  expect((await call(capture.repeat(5), { value: "x".repeat(65536) }, "plain")).status).toBe(400);
});
