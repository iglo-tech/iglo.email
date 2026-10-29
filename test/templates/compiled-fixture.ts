// Test-only HTTP caller of the production renderer, including file and loopback traps.
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRenderer } from "@/templates/renderer";
import { createRealClock } from "@/clock";
import { createTranslation, Translation } from "@/i18n/i18n";
import { initialTemplates, systemTemplates } from "@/templates/builtins";
import {
  budgetBypassBodies,
  loopMetadataBody,
  loopMetadataOutput,
  loopModifierControls,
  modifierCoercionCase,
} from "@/test/templates/budget-cases";

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
            data: JSON.stringify(value.data),
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
  for (const body of budgetBypassBodies) {
    const response = await fetch(fixture.url, {
      method: "POST",
      body: JSON.stringify({ body, data: {} }),
    });
    assert.equal(response.status, 400, "loop/filter budget bypass");
  }
  const loopControl = await fetch(fixture.url, {
    method: "POST",
    body: JSON.stringify({ body: loopMetadataBody, data: {} }),
  });
  assert.equal(loopControl.status, 200);
  assert.equal(await loopControl.text(), loopMetadataOutput);
  const coercion = await fetch(fixture.url, {
    method: "POST",
    body: JSON.stringify(modifierCoercionCase),
  });
  assert.equal(coercion.status, 400);
  for (const control of loopModifierControls) {
    const response = await fetch(fixture.url, {
      method: "POST",
      body: JSON.stringify({ body: control.body, data: {} }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), control.output);
  }
  let touched = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        touched++;
        throw Error("read");
      },
      ownKeys() {
        touched++;
        throw Error("keys");
      },
      getPrototypeOf() {
        touched++;
        throw Error("prototype");
      },
    },
  );
  const hidden: Record<PropertyKey, unknown> = {};
  for (let i = 0; i < 1100; i++) Object.defineProperty(hidden, `hidden${i}`, { value: i });
  Object.defineProperty(hidden, "getter", {
    enumerable: true,
    get() {
      touched++;
      throw Error("getter");
    },
  });
  hidden[Symbol("s")] = 1;
  const enumerable = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`key${i}`, i]));
  const executable = {
    toJSON() {
      touched++;
      return {};
    },
    valueOf() {
      touched++;
      return {};
    },
    [Symbol.iterator]() {
      touched++;
      throw Error("iterator");
    },
  };
  class CallerValue {
    value = "class";
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const compiled = renderer.compile({ body: "ok", mode: "plain" });
  for (const value of [
    proxy,
    hidden,
    enumerable,
    executable,
    new CallerValue(),
    cycle,
    new Date(),
    () => {
      touched++;
    },
    Symbol("s"),
    [],
    null,
  ]) {
    const data = value as string;
    assert.throws(() => renderer.renderSync({ body: "ok", mode: "plain", data }));
    assert.throws(() => compiled.renderSync(data));
    await assert.rejects(renderer.render({ body: "ok", mode: "plain", data }));
    await assert.rejects(compiled.render(data));
  }
  assert.equal(touched, 0);
  const chunk = "é".repeat(32768);
  const wire = { a: chunk, b: chunk, c: chunk, d: "" };
  wire.d = "é".repeat(Math.floor((256 * 1024 - Buffer.byteLength(JSON.stringify(wire))) / 2)) + "x";
  const exact = JSON.stringify(wire);
  assert.equal(Buffer.byteLength(exact), 256 * 1024);
  assert.equal(compiled.renderSync(exact).body, "ok");
  assert.throws(() => compiled.renderSync(exact + " "));
  assert.throws(
    () => compiled.renderSync('{"private-data-canary'),
    (error: unknown) => error instanceof Error && error.message === "Invalid template data",
  );
  for (const invalid of [
    '{"x":1e400}',
    '{"x":{"constructor":0}}',
    JSON.stringify({ a: Array(1025).fill(0) }),
  ])
    assert.throws(() => compiled.renderSync(invalid));
  const markdown = renderer.compile({
    body: "# Hello {{ name }}\n\n[link][ref]\n\n[ref]: https://example.invalid/path",
    layout: "<main>{{ content | raw }}</main>",
    mode: "markdown",
  });
  assert.equal(
    markdown.renderSync(JSON.stringify({ name: "A & B" })).body,
    '<main><h1>Hello A &amp; B</h1>\n<p><a href="https://example.invalid/path">link</a></p>\n</main>',
  );
  const longReference = `[ref]: https://example.invalid/${"x".repeat(40000)}\n\n`;
  for (const prefix of ["[x][ref] ", "![x][ref] "]) {
    assert.throws(() =>
      renderer.renderSync({
        body: longReference + prefix.repeat(40),
        data: "{}",
        mode: "markdown",
      }),
    );
  }
  const wideTable = "|" + "h|".repeat(10001) + "\n|" + "- |".repeat(10001) + "\n";
  assert.throws(() => renderer.renderSync({ body: wideTable, data: "{}", mode: "markdown" }));
  assert.throws(() =>
    renderer.renderSync({ body: "> x\n".repeat(10001), data: "{}", mode: "markdown" }),
  );
  const boundedMarkdown = renderer.compile({
    body: "<div>{% for i in (1..15) %}{{ x | raw }}{% endfor %}{{ y | raw }}</div>",
    mode: "markdown",
  });
  const payload = { x: "a".repeat(65536), y: "a".repeat(65525) };
  assert.equal(
    Buffer.byteLength(boundedMarkdown.renderSync(JSON.stringify(payload)).body),
    1024 * 1024,
  );
  payload.y += "a";
  assert.throws(() => boundedMarkdown.renderSync(JSON.stringify(payload)));
  const plain = renderer.compile({ body: "{{ value }}", subject: "{{ value }}", mode: "plain" });
  assert.deepEqual(plain.renderSync(JSON.stringify({ value: "<a>&" })), {
    body: "<a>&",
    subject: "<a>&",
  });
  assert.equal(
    renderer.renderSync({
      body: '{{ "globals.messages.invalidFields" | t: "name", "x" }}',
      mode: "plain",
      data: "{}",
    }).body,
    "Invalid fields: x",
  );
  assert.match(
    renderer.renderSync({ body: '{{ "now" | date: "%Y-%m-%d" }}', mode: "plain", data: "{}" }).body,
    /^\d{4}-\d{2}-\d{2}$/,
  );
  assert.throws(() =>
    renderer.renderSync({
      body: "{{ value | track_link }}",
      mode: "html",
      data: JSON.stringify({ value: "javascript:alert(1)" }),
    }),
  );
  assert.throws(() =>
    renderer.renderSync({
      body: '{{ value | replace: "a", "b" }}',
      mode: "html",
      data: JSON.stringify({ value: "a" }),
    }),
  );
  assert.equal(
    Buffer.byteLength(plain.renderSync(JSON.stringify({ value: "é".repeat(1024) })).subject),
    2048,
  );
  assert.throws(() => plain.renderSync(JSON.stringify({ value: "é".repeat(1024) + "x" })));
  assert.throws(() =>
    renderer.renderSync({
      body: "{% if true %}".repeat(33) + "x" + "{% endif %}".repeat(33),
      data: "{}",
      mode: "plain",
    }),
  );
  const capture =
    "{% capture x %}{% for n in (1..16) %}{{ value | raw }}{% endfor %}{% endcapture %}";
  const captureData = JSON.stringify({ value: "x".repeat(65536) });
  assert.equal(
    renderer.renderSync({ body: capture.repeat(4), data: captureData, mode: "plain" }).body,
    "",
  );
  assert.throws(() =>
    renderer.renderSync({ body: capture.repeat(4) + "x", data: captureData, mode: "plain" }),
  );
  const rangeExact = renderer.renderSync({
    body: "{% for i in (1..1024) %}x{% endfor %}",
    data: "{}",
    mode: "plain",
  });
  assert.equal(rangeExact.body.length, 1024);
  const snapshotInput = { body: "<p>{{ value }}</p>", mode: "html" as const };
  const immutable = renderer.compile(snapshotInput);
  snapshotInput.body = "changed";
  assert.equal(immutable.renderSync(JSON.stringify({ value: "A & B" })).body, "<p>A &amp; B</p>");
  let deep: unknown = null;
  for (let i = 0; i < 17; i++) deep = [deep];
  assert.throws(() => plain.renderSync(JSON.stringify({ value: deep })));
  assert.throws(() =>
    plain.renderSync(
      JSON.stringify({ value: Array.from({ length: 10 }, () => Array(1024).fill(0)) }),
    ),
  );
  assert.throws(() =>
    renderer.renderSync({
      body: "{% for i in (1..65) %}{% assign x = value | upcase %}{% endfor %}",
      mode: "plain",
      data: JSON.stringify({ value: "x".repeat(65536) }),
    }),
  );
  const builtInData = JSON.stringify({
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
  });
  const expected = {
    campaignStatus: "Synthetic",
    importStatus: "Synthetic import",
    forgotPassword: "https://example.invalid/reset",
    subscriberData: "<h2>",
    subscriberOptin: "Synthetic List",
    subscriberOptinCampaign: "Synthetic List",
    smtpTest: "<h2>",
  };
  for (const [name, marker] of Object.entries(expected)) {
    const result = renderer.renderSync({
      body: systemTemplates[name as keyof typeof systemTemplates],
      mode: "html",
      data: builtInData,
    });
    assert.ok(result.body.includes(marker));
  }
  for (const item of initialTemplates) {
    const result =
      item.type === "campaign"
        ? renderer.renderSync({
            body: "<p>Hi</p>",
            layout: item.body,
            mode: "html",
            data: builtInData,
          })
        : renderer.renderSync({
            body: item.body,
            subject: item.subject,
            mode: "html",
            data: builtInData,
            transactional: true,
          });
    assert.ok(result.body.includes(item.type === "campaign" ? "<p>Hi</p>" : "1234"));
    if (item.type === "tx") assert.equal(result.subject, "Welcome A & B");
  }
  const first = createRenderer(
    { now: () => new Date("2026-01-02T00:00:00Z"), sleep: async () => {} },
    new Translation({ "_.code": "a", "_.name": "A", fixture: "First" }),
  );
  const second = createRenderer(
    { now: () => new Date("2026-01-03T00:00:00Z"), sleep: async () => {} },
    new Translation({ "_.code": "b", "_.name": "B", fixture: "Second" }),
  );
  const instanceRequest = {
    body: '{{ "fixture" | t }} {{ "now" | date: "%Y-%m-%d" }}',
    mode: "plain" as const,
    data: "{}",
  };
  const admissions = await Promise.allSettled([
    first.render(instanceRequest),
    first.render(instanceRequest),
    first.render(instanceRequest),
    first.render(instanceRequest),
    first.render(instanceRequest),
    second.render(instanceRequest),
  ]);
  assert.deepEqual(
    admissions.map((v) => v.status),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"],
  );
  assert.equal((await first.render(instanceRequest)).body, "First 2026-01-02");
  assert.equal((await second.render(instanceRequest)).body, "Second 2026-01-03");
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
  assert.equal(
    (await send("{% include path %}", { path: `http://127.0.0.1:${trap.port}/` })).status,
    400,
  );
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
