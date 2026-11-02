// B4 public-form CAPTCHA through the public HTTP boundary, on the injected clock. ALTCHA is solved
// by a test client; hCaptcha is a local fake siteverify. Upstream-compared results are in
// test/contract/public.ts.
import { afterEach, expect, test } from "bun:test";
import type { CaptchaOptions } from "@/captcha/captcha";
import { altchaPayload, solveAltcha, type AltchaChallenge } from "@/test/public/altcha-solver";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const fixtures: PublicFixture[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const f of fixtures.splice(0)) await f.close();
});
async function open(captcha?: Partial<CaptchaOptions>) {
  const f = await publicFixture();
  fixtures.push(f);
  if (captcha) setCaptcha(f, captcha);
  return f;
}
function setCaptcha(f: PublicFixture, captcha: Partial<CaptchaOptions>) {
  f.store.update((current) => ({
    ...current,
    "security.captcha": {
      altcha: { enabled: false, complexity: 300, ...captcha.altcha },
      hcaptcha: { enabled: false, key: "", secret: "", ...captcha.hcaptcha },
    },
  }));
}
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const challenge = async (f: PublicFixture) => {
  const response = await f.peer("/api/public/captcha/altcha", "192.0.2.50");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  return JSON.parse(await response.text()) as AltchaChallenge;
};
const subscribers = (f: PublicFixture) =>
  Number((f.db.query("SELECT count(*) AS n FROM subscribers").get() as { n: bigint }).n);
const submit = (f: PublicFixture, email: string, list: string, extra: Record<string, string>) =>
  f.fresh("/subscription/form", form({ email, l: list, ...extra }));
const refused = async (response: Response) => {
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("Invalid CAPTCHA.");
};

test("without a provider the challenge is 404 and the form has no widget", async () => {
  const f = await open();
  await f.list("News");
  const response = await f.peer("/api/public/captcha/altcha", "192.0.2.50");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: "captcha not enabled" });
  const page = await (await f.peer("/subscription/form", "192.0.2.50")).text();
  expect(page).not.toContain("altcha-widget");
  expect(page).not.toContain("h-captcha");
  // hCaptcha alone serves no ALTCHA challenge either.
  setCaptcha(f, { hcaptcha: { enabled: true, key: "k", secret: "s" } });
  expect((await f.peer("/api/public/captcha/altcha", "192.0.2.50")).status).toBe(404);
});

test("an ALTCHA challenge has altcha-lib's v2 shape and a 5 minute expiry", async () => {
  const f = await open({ altcha: { enabled: true, complexity: 300 } });
  const c = await challenge(f);
  expect(Object.keys(c)).toEqual(["parameters", "signature"]);
  expect(Object.keys(c.parameters)).toEqual([
    "algorithm",
    "nonce",
    "salt",
    "cost",
    "keyLength",
    "keyPrefix",
    "expiresAt",
  ]);
  expect(c.parameters).toMatchObject({ algorithm: "SHA-256", cost: 1, keyLength: 32 });
  expect(c.parameters.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(c.parameters.salt).toMatch(/^[0-9a-f]{32}$/);
  expect(c.parameters.keyPrefix).toMatch(/^[0-9a-f]{32}$/);
  expect(c.signature).toMatch(/^[0-9a-f]{64}$/);
  expect(c.parameters.expiresAt).toBe(f.clock.now().getTime() / 1000 + 300);
  // The counter is drawn from 0 to the complexity, inclusive.
  for (let i = 0; i < 20; i++)
    expect(solveAltcha(await challenge(f)).counter).toBeLessThanOrEqual(300);
  setCaptcha(f, { altcha: { enabled: true, complexity: 0 } });
  expect(solveAltcha(await challenge(f)).counter).toBe(0);
});

test("the form shows the widget, and a solved challenge subscribes once", async () => {
  const f = await open({ altcha: { enabled: true, complexity: 300 } });
  const list = await f.list("News");
  const page = await (await f.peer("/subscription/form", "192.0.2.50")).text();
  expect(page).toContain(
    '<altcha-widget challenge="http://fixture.test/api/public/captcha/altcha"></altcha-widget>',
  );
  expect(page).toMatch(
    /<script type="module" src="\/public\/static\/altcha\.umd\.js\?v=[0-9a-f]{10}"/,
  );
  // Without a solution, the form is refused and nothing is stored.
  const before = subscribers(f);
  await refused(await submit(f, "none@example.test", list.uuid, {}));
  await refused(await submit(f, "empty@example.test", list.uuid, { altcha: "" }));
  expect(subscribers(f)).toBe(before);
  const payload = altchaPayload(await challenge(f));
  const ok = await submit(f, "ada@example.test", list.uuid, { altcha: payload });
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("Subscribed successfully.");
  expect(subscribers(f)).toBe(before + 1);
  // A replayed solution is refused, for another address too.
  await refused(await submit(f, "bob@example.test", list.uuid, { altcha: payload }));
  expect(subscribers(f)).toBe(before + 1);
  // The solution may come in the query, as Echo's FormValue reads it.
  const query = new URLSearchParams({ altcha: altchaPayload(await challenge(f)) });
  const viaQuery = await f.fresh(
    `/subscription/form?${query}`,
    form({ email: "cy@example.test", l: list.uuid }),
  );
  expect(viaQuery.status).toBe(200);
  expect(f.errors).toEqual([]);
});

test("an expired ALTCHA solution is refused, and expiry has sub-second precision", async () => {
  const f = await open({ altcha: { enabled: true, complexity: 100 } });
  const list = await f.list("News");
  const late = altchaPayload(await challenge(f));
  const edge = altchaPayload(await challenge(f));
  f.clock.advance(300_000);
  expect((await submit(f, "edge@example.test", list.uuid, { altcha: edge })).status).toBe(200);
  f.clock.advance(1);
  await refused(await submit(f, "late@example.test", list.uuid, { altcha: late }));
});

test("a tampered or malformed ALTCHA payload is refused", async () => {
  const f = await open({ altcha: { enabled: true, complexity: 100 } });
  const list = await f.list("News");
  const c = await challenge(f);
  const solution = solveAltcha(c);
  const other = await challenge(f);
  const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  const cases: string[] = [
    altchaPayload(c, { ...solution, counter: solution.counter + 1 }),
    altchaPayload(c, { ...solution, derivedKey: flip(solution.derivedKey) }),
    altchaPayload(c, { ...solution, derivedKey: solution.derivedKey.toUpperCase() }),
    altchaPayload(c, { ...solution, counter: -1 }),
    altchaPayload({ ...c, signature: flip(c.signature) }, solution),
    altchaPayload({ ...c, signature: c.signature.toUpperCase() }, solution),
    altchaPayload(
      { ...c, parameters: { ...c.parameters, expiresAt: c.parameters.expiresAt + 60 } },
      solution,
    ),
    altchaPayload({ ...c, parameters: { ...c.parameters, cost: 2 } }, solution),
    altchaPayload({ ...c, parameters: { ...c.parameters, keyPrefix: "0" } }, solution),
    altchaPayload({ ...c, parameters: { ...c.parameters, algorithm: "SHA-512" } }, solution),
    altchaPayload({ ...c, parameters: { ...c.parameters, keySignature: "ab" } } as never, solution),
    altchaPayload({ ...c, parameters: { ...c.parameters, data: {} } } as never, solution),
    // Another challenge's signature with this one's solution.
    altchaPayload({ ...c, signature: other.signature }, solution),
    btoa(JSON.stringify({ challenge: c })),
    btoa(JSON.stringify({ challenge: null, solution: null, test: true })),
    btoa("not json"),
    "%%%",
    altchaPayload(c, solution).slice(0, -2),
    "A".repeat(8192),
  ];
  for (const altcha of cases)
    await refused(await submit(f, "x@example.test", list.uuid, { altcha }));
  // The untampered payload still verifies: nothing above consumed it.
  const ok = await submit(f, "ok@example.test", list.uuid, { altcha: altchaPayload(c, solution) });
  expect(ok.status).toBe(200);
  // Unknown keys are ignored, as Go's decoder ignores them.
  const extra = await challenge(f);
  const payload = btoa(
    JSON.stringify({
      challenge: { ...extra, parameters: { ...extra.parameters, note: "x" }, more: 1 },
      solution: { ...solveAltcha(extra), extra: true },
    }),
  );
  expect((await submit(f, "extra@example.test", list.uuid, { altcha: payload })).status).toBe(200);
  expect(f.errors).toEqual([]);
});

test("used ALTCHA signatures are bounded and released when they expire", async () => {
  // The fixture holds at most 50 used signatures.
  const f = await open({ altcha: { enabled: true, complexity: 0 } });
  const list = await f.list("News");
  for (let i = 0; i < 50; i++) {
    const response = await submit(f, `n${i}@example.test`, list.uuid, {
      altcha: altchaPayload(await challenge(f)),
    });
    expect(response.status).toBe(200);
  }
  const fresh = altchaPayload(await challenge(f));
  await refused(await submit(f, "full@example.test", list.uuid, { altcha: fresh }));
  // Once the used ones expire, a new challenge verifies again.
  f.clock.advance(300_001);
  expect(
    (
      await submit(f, "later@example.test", list.uuid, {
        altcha: altchaPayload(await challenge(f)),
      })
    ).status,
  ).toBe(200);
});

test("the JSON subscription API takes no captcha, as upstream", async () => {
  const f = await open({ altcha: { enabled: true, complexity: 100 } });
  const list = await f.list("News");
  const response = await f.peer("/api/public/subscription", "192.0.2.60", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "api@example.test", list_uuids: [list.uuid] }),
  });
  expect(response.status).toBe(200);
});

function fakeSiteverify(answer: (request: Request) => Response | Promise<Response>) {
  const seen: { secret: string | null; response: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = new URLSearchParams(await request.text());
      seen.push({ secret: body.get("secret"), response: body.get("response") });
      return answer(request);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/siteverify`, seen };
}

test("hCaptcha: the form embeds the site key and siteverify decides", async () => {
  const f = await open({ hcaptcha: { enabled: true, key: "site-key", secret: "hc-secret" } });
  const list = await f.list("News");
  const page = await (await f.peer("/subscription/form", "192.0.2.50")).text();
  expect(page).toContain('<div class="h-captcha" data-sitekey="site-key"></div>');
  expect(page).toContain('<script src="https://js.hcaptcha.com/1/api.js" async defer></script>');
  expect(page).not.toContain("altcha-widget");
  let success = true;
  const fake = fakeSiteverify(() => Response.json({ success, error_codes: [] }));
  f.hcaptcha.url = fake.url;
  // A missing token never reaches siteverify.
  await refused(await submit(f, "none@example.test", list.uuid, {}));
  expect(fake.seen).toEqual([]);
  const ok = await submit(f, "hc@example.test", list.uuid, { "h-captcha-response": "token-1" });
  expect(ok.status).toBe(200);
  expect(fake.seen).toEqual([{ secret: "hc-secret", response: "token-1" }]);
  success = false;
  await refused(await submit(f, "no@example.test", list.uuid, { "h-captcha-response": "token-2" }));
  // ALTCHA is not accepted in hCaptcha's place.
  await refused(await submit(f, "alt@example.test", list.uuid, { altcha: "x" }));
});

test("hCaptcha fails closed on an unusable siteverify answer", async () => {
  const f = await open({ hcaptcha: { enabled: true, key: "site-key", secret: "hc-secret" } });
  const list = await f.list("News");
  const answers: (() => Response)[] = [
    () => new Response("not json"),
    () => Response.json({ success: "true" }),
    () => Response.json({ success: true }, { status: 500 }),
    () => new Response(JSON.stringify({ success: true, pad: "x".repeat(70_000) })),
    () => Response.redirect("http://127.0.0.1:1/", 302),
  ];
  let next = 0;
  const fake = fakeSiteverify(() => answers[next]!());
  f.hcaptcha.url = fake.url;
  for (; next < answers.length; next++)
    await refused(await submit(f, "x@example.test", list.uuid, { "h-captcha-response": "t" }));
  // An unreachable siteverify fails closed too.
  f.hcaptcha.url = "http://127.0.0.1:1/siteverify";
  await refused(await submit(f, "y@example.test", list.uuid, { "h-captcha-response": "t" }));
  expect(f.errors).toEqual([]);
});

test("ALTCHA wins when both providers are enabled, as upstream", async () => {
  const f = await open({
    altcha: { enabled: true, complexity: 50 },
    hcaptcha: { enabled: true, key: "k", secret: "s" },
  });
  const list = await f.list("News");
  const page = await (await f.peer("/subscription/form", "192.0.2.50")).text();
  expect(page).toContain("altcha-widget");
  expect(page).not.toContain("h-captcha");
  const ok = await submit(f, "both@example.test", list.uuid, {
    altcha: altchaPayload(await challenge(f)),
  });
  expect(ok.status).toBe(200);
});
