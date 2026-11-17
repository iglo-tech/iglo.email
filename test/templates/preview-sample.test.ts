// The template preview's optional `sample` form field (docs/design/06-templates.md#preview-data,
// D105), through POST /api/templates/preview. Without it the preview is the dummy context, exactly
// as before; with it, the sample's named parts replace the dummy ones and nothing else changes.
import { afterEach, expect, test } from "bun:test";
import { sequencesFixture, type SequencesFixture } from "@/test/sequences/fixture";

const fixtures: SequencesFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await sequencesFixture();
  fixtures.push(f);
  return f;
}

/** A preview of `body` as a template of `type`, with an optional sample (a JSON string). */
async function preview(f: SequencesFixture, body: string, type = "tx", sample?: string) {
  const form = new URLSearchParams({ template_type: type, body });
  if (sample !== undefined) form.set("sample", sample);
  const response = await f.request("/api/templates/preview", {
    method: "POST",
    headers: { ...f.sessionHeaders, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { status: response.status, text: await response.text() };
}
const TEMPLATE =
  "{{ subscriber.name }}|{{ trigger.data.items }}|{{ aggregates.x | number | default: 0 }}|{{ data.order_id }}";

test("without a sample the preview is the dummy context, with zero aggregates", async () => {
  const f = await open();
  const r = await preview(f, TEMPLATE);
  expect(r.status).toBe(200);
  expect(r.text).toBe("John Doe||0|12345");
});

test("a sample replaces the named parts of the dummy context", async () => {
  const f = await open();
  const r = await preview(
    f,
    TEMPLATE,
    "tx",
    JSON.stringify({
      subscriber: { name: "Grace Hopper" },
      trigger: { data: { items: 7 } },
      aggregates: { x: 1234567 },
      data: { order_id: "9" },
    }),
  );
  expect(r.status).toBe(200);
  expect(r.text).toBe("Grace Hopper|7|1,234,567|9");
});

test("a sample on a campaign preview replaces the data it names too", async () => {
  const f = await open();
  const r = await preview(
    f,
    "<p>{{ subscriber.name }} {{ aggregates.x | number }}</p>{{ content | raw }}",
    "campaign",
    JSON.stringify({ subscriber: { name: "Ada" }, aggregates: { x: 42 } }),
  );
  expect(r.status).toBe(200);
  expect(r.text).toContain("<p>Ada 42</p>");
});

test("a malformed or unknown sample is 400 naming the field", async () => {
  const f = await open();
  for (const [sample, message] of [
    ["not json", "Invalid fields: sample"],
    ['"text"', "Invalid fields: sample"],
    [JSON.stringify({ aggregates: { x: "5" } }), "Invalid fields: sample.aggregates.x"],
    [JSON.stringify({ subscriber: { id: 5 } }), "Invalid fields: sample.subscriber.id"],
    [
      JSON.stringify({ trigger: { occurred_at: "nope" } }),
      "Invalid fields: sample.trigger.occurred_at",
    ],
    [
      JSON.stringify({ subscriber: { attribs: { big: "x".repeat(70 * 1024) } } }),
      "Invalid fields: sample",
    ],
  ] as const) {
    const r = await preview(f, TEMPLATE, "tx", sample);
    expect([sample.slice(0, 40), r.status, JSON.parse(r.text).message]).toEqual([
      sample.slice(0, 40),
      400,
      message,
    ]);
  }
});

test("a sample nested past the template data depth is 400, and the preview still answers", async () => {
  const f = await open();
  // Form-encoded, 80,000 levels is about 480 KB: under the body limit, far past the data depth.
  const deep = `{"subscriber":{"attribs":{"x":${"[".repeat(80_000)}${"]".repeat(80_000)}}}}`;
  const refused = await preview(f, TEMPLATE, "tx", deep);
  expect(refused.status).toBe(400);
  expect(refused.text).toContain("sample");
  expect((await preview(f, TEMPLATE)).status).toBe(200);
});
