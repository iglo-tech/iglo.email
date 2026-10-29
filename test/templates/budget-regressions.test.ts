import { expect, test } from "bun:test";
import { createRenderer } from "@/templates/renderer";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import {
  budgetBypassBodies,
  loopMetadataBody,
  loopMetadataOutput,
} from "@/test/templates/budget-cases";

test("loop helper conversions and literal filter arguments obey the message budget", async () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const body = await request.text();
        return new Response((await renderer.render({ body, mode: "plain", data: "{}" })).body);
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
    const positive = await fetch(server.url, { method: "POST", body: loopMetadataBody });
    expect(positive.status).toBe(200);
    expect(await positive.text()).toBe(loopMetadataOutput);
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
