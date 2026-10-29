import { expect, test } from "bun:test";
import { createRenderer } from "@/templates/renderer";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import {
  budgetBypassBodies,
  loopMetadataBody,
  loopMetadataOutput,
  loopModifierControls,
  coercionCases,
} from "@/test/templates/budget-cases";

test("loop conversions and filter/for arguments obey the message budget", async () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const value =
          request.headers.get("content-type") === "application/json"
            ? ((await request.json()) as { body: string; data: string })
            : { body: await request.text(), data: "{}" };
        return new Response((await renderer.render({ ...value, mode: "plain" })).body);
      } catch {
        return new Response("invalid", { status: 400 });
      }
    },
  });
  try {
    for (const body of budgetBypassBodies) {
      const response = await fetch(server.url, { method: "POST", body });
      expect(response.status).toBe(400);
    }
    for (const coercionCase of coercionCases) {
      const coercion = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: coercionCase.body,
          data: JSON.stringify(coercionCase.data),
        }),
      });
      expect(coercion.status).toBe(400);
    }
    const positive = await fetch(server.url, { method: "POST", body: loopMetadataBody });
    expect(positive.status).toBe(200);
    expect(await positive.text()).toBe(loopMetadataOutput);
    for (const control of loopModifierControls) {
      const response = await fetch(server.url, { method: "POST", body: control.body });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(control.output);
    }
    for (const name of ["unused", "__proto__", "constructor", "prototype"]) {
      const response = await fetch(server.url, {
        method: "POST",
        body: `{% for i in (1..1) ${name}:1 %}x{% endfor %}`,
      });
      expect(response.status).toBe(400);
    }
    for (const property of ["valueOf", "next", "name", "liquidMethodMissing"]) {
      const response = await fetch(server.url, {
        method: "POST",
        body: `{% for i in (1..2) %}{{ forloop.${property} | raw }}{% endfor %}`,
      });
      expect(response.status).toBe(400);
    }
    for (const body of [
      "{{ 'x' | default: 'fallback', 1 }}",
      "{{ 'now' | date: '%Y', 1 }}",
      "{{ 'x' | strip: 1 }}",
      "{{ 'x' | raw: 1 }}",
      "{{ 'https://example.test' | track_link: 1 }}",
      "{{ 'x' | t: 'a' }}",
    ])
      expect((await fetch(server.url, { method: "POST", body })).status).toBe(400);
    const supported = await fetch(server.url, {
      method: "POST",
      body: "{{ ' x ' | strip | upcase }}{{ '' | default: 'fallback' }}{{ 'now' | date: '%Y' }}{{ 'x' | t: 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h' }}",
    });
    expect(supported.status).toBe(200);
    expect(await supported.text()).toMatch(/^Xfallback\d{4}x$/);
  } finally {
    await server.stop(true);
  }
});
