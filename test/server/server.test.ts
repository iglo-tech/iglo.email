import { afterEach, describe, expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation, Translation } from "@/i18n/i18n";
import { startFixture, TestClock } from "@/test/server/fixture";
import { rawGet } from "@/test/server/raw-request";

const fixtures: ReturnType<typeof startFixture>[] = [];
function fixture(options: Parameters<typeof startFixture>[0] = {}) {
  const result = startFixture(options);
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ server }) => server.stop(true)));
});

async function request(origin: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(2_000) });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    order: response.headers.get("x-order"),
    body: await response.text(),
  };
}

describe("shared HTTP contracts", () => {
  test("health and API fallback match the reference, including methods and HEAD", async () => {
    const { origin } = fixture();
    expect(await request(origin, "/health")).toMatchObject({
      status: 200,
      contentType: "application/json",
      body: '{"data":true}\n',
    });
    for (const path of ["/api/not-present", "/api/health", "/api/lang/en"]) {
      expect(await request(origin, path)).toMatchObject({
        status: 404,
        contentType: "application/json",
        body: '{"message":"404 unknown endpoint"}\n',
      });
    }
    expect(await request(origin, "/api/not-present", { method: "HEAD" })).toMatchObject({
      status: 404,
      contentType: null,
      body: "",
    });
    expect(await request(origin, "/api/not-present", { method: "POST" })).toMatchObject({
      status: 404,
      contentType: "application/json",
      body: '{"message":"404 unknown endpoint"}\n',
    });
    expect(await request(origin, "/health", { method: "HEAD" })).toMatchObject({
      status: 404,
      contentType: "text/html; charset=UTF-8",
      body: "",
    });
    expect((await request(origin, "/health", { method: "POST" })).status).toBe(404);
  });

  test("static paths outrank parameters and query/parameter values stay request-local", async () => {
    const { origin } = fixture();
    expect((await request(origin, "/fixture/items/special")).body).toBe('{"data":"static"}\n');
    const [one, two] = await Promise.all([
      request(origin, "/fixture/items/one?q=first"),
      request(origin, "/fixture/items/two?q=second"),
    ]);
    expect(one.body).toBe('{"data":{"item":"one","query":"first"}}\n');
    expect(two.body).toBe('{"data":{"item":"two","query":"second"}}\n');
    expect((await request(origin, "/fixture/items/one", { method: "POST" })).status).toBe(404);
  });

  test("path parameters retain the reference URI spelling without extra unescaping", async () => {
    const { origin } = fixture();
    for (const [path, item] of [
      ["%31%32", "%31%32"],
      ["%2B12", "%2B12"],
      ["%20", " "],
      ["%2524", "%24"],
      ["%C3%A9", "é"],
      ["%c3%a9", "%c3%a9"],
      ["%2F", "%2F"],
    ]) {
      const result = await request(origin, `/fixture/items/${path}`);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ data: { item, query: null } });
    }
  });

  test("static routes outrank parameters with prefix and longer routes interleaved", async () => {
    const prefix = "/fixture/routes";
    for (const suffix of ["", "/export"]) {
      const parameter = `${prefix}/:id${suffix}`;
      const literal = `${prefix}/new${suffix}`;
      for (const routePaths of [
        [parameter, prefix, literal],
        [parameter, literal, prefix],
        [prefix, parameter, literal],
        [prefix, literal, parameter],
        [literal, prefix, parameter],
        [literal, parameter, prefix],
      ]) {
        const { origin } = fixture({ routePaths });
        expect((await request(origin, literal)).body).toBe(
          `${JSON.stringify({ data: literal })}\n`,
        );
        expect((await request(origin, `${prefix}/123${suffix}`)).body).toBe(
          `${JSON.stringify({ data: parameter })}\n`,
        );
        expect((await request(origin, prefix)).body).toBe(`${JSON.stringify({ data: prefix })}\n`);
      }
    }
  });

  test("middleware runs in registration order, can short-circuit, and errors share serialization", async () => {
    const { origin, errors } = fixture();
    expect(await request(origin, "/fixture/middleware")).toMatchObject({
      status: 200,
      body: '{"data":"handler"}\n',
      order: "outer(inner(route(handler)))",
    });
    expect(await request(origin, "/fixture/short")).toMatchObject({
      status: 200,
      body: '{"data":"short"}\n',
      order: "outer(inner(handler))",
    });
    for (const [path, message] of [
      ["/fixture/handler-error", "from handler"],
      ["/fixture/middleware-error", "from middleware"],
    ]) {
      expect(await request(origin, path!)).toMatchObject({
        status: 400,
        contentType: "application/json",
        body: `{"message":"${message}"}\n`,
      });
    }
    expect(errors).toHaveLength(0);
  });

  test("unexpected asynchronous handler and middleware errors are logged and hidden", async () => {
    const { origin, errors } = fixture();
    for (const path of ["/fixture/unexpected", "/fixture/unexpected-middleware"]) {
      const result = await request(origin, path);
      expect(result).toMatchObject({
        status: 500,
        contentType: "application/json",
        body: '{"message":"Internal Server Error"}\n',
      });
      expect(result.body).not.toContain("private");
      expect(result.body).not.toContain("secret");
    }
    expect(errors).toHaveLength(2);
  });

  test("ID and generic input validation reproduce reference 400 envelopes", async () => {
    const { origin } = fixture();
    for (const id of ["not-an-id", "0", "-1"]) {
      expect(await request(origin, `/fixture/id/${id}`)).toMatchObject({
        status: 400,
        contentType: "application/json",
        body: '{"message":"invalid ID"}\n',
      });
    }
    expect((await request(origin, "/fixture/id/+12")).body).toBe('{"data":12}\n');
    expect((await request(origin, "/fixture/id/9007199254740993")).body).toBe(
      '{"data":"9007199254740993"}\n',
    );
    expect(await request(origin, "/fixture/field/type")).toMatchObject({
      status: 400,
      contentType: "application/json",
      body: '{"message":"Invalid fields: type"}\n',
    });
    expect((await request(origin, "/fixture/escape")).body).toBe(
      '{"data":"\\u003c\\u003e\\u0026\\u2028\\u2029"}\n',
    );
    const post = (body: string) =>
      request(origin, "/fixture/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    expect(await post('{"value":""}')).toMatchObject({
      status: 400,
      body: '{"message":"Invalid name."}\n',
    });
    expect(await post("{")).toMatchObject({ status: 400, body: '{"message":"Bad Request"}\n' });
    expect((await post('{"value":"hello"}')).body).toBe('{"data":"hello"}\n');
    expect((await post(JSON.stringify({ value: "é".repeat(1001) }))).status).toBe(400);
  });

  test("empty bodies reach field validation while nonempty unsupported media remains 415", async () => {
    const { origin } = fixture();
    for (const init of [
      { method: "POST" },
      { method: "POST", body: "", headers: { "Content-Type": "application/json" } },
    ]) {
      expect(await request(origin, "/fixture/input", init)).toMatchObject({
        status: 400,
        contentType: "application/json",
        body: '{"message":"Invalid name."}\n',
      });
    }
    expect(
      await request(origin, "/fixture/input", {
        method: "POST",
        body: "not JSON",
        headers: { "Content-Type": "text/plain" },
      }),
    ).toMatchObject({
      status: 415,
      contentType: "application/json",
      body: '{"message":"Unsupported Media Type"}\n',
    });
  });

  test("D17 deliberate difference: positive ID overflow is a client error before storage", async () => {
    const { origin } = fixture();
    expect(await request(origin, "/fixture/id/9223372036854775808")).toMatchObject({
      status: 400,
      contentType: "application/json",
      body: '{"message":"invalid ID"}\n',
    });
  });

  test("escaped IDs fail validation like the live reference", async () => {
    const { origin } = fixture();
    for (const id of ["%31%32", "%2B12", "1%32", "%252B12", "%FF"]) {
      expect(await request(origin, `/fixture/id/${id}`)).toMatchObject({
        status: 400,
        contentType: "application/json",
        body: '{"message":"invalid ID"}\n',
      });
    }
  });

  test("D18 deliberate difference: Bun normalizes encoded dot segments before routing", async () => {
    const { origin } = fixture();
    for (const id of ["%2E", "%2E%2E"]) {
      expect(await rawGet(origin, `/api/lists/${id}`)).toMatchObject({
        status: 404,
        contentType: "application/json",
        body: '{"message":"404 unknown endpoint"}\n',
      });
    }
  });

  test("D18 deliberate difference: Bun normalizes literal backslashes before routing", async () => {
    const { origin } = fixture();
    expect(await rawGet(origin, "/fixture/id\\12")).toMatchObject({
      status: 200,
      contentType: "application/json",
      body: '{"data":12}\n',
    });
    expect(await rawGet(origin, "/fixture\\items\\x")).toMatchObject({
      status: 200,
      contentType: "application/json",
      body: '{"data":{"item":"x","query":null}}\n',
    });
  });

  test("malformed path percent escapes fail before routing while query values remain independent", async () => {
    const { origin } = fixture();
    for (const path of [
      "/fixture/id/%zz",
      "/fixture/items/%zz",
      "/fixture/id/1%",
      "/fixture/id/%2",
      "/api/lists%zz",
      "/health%zz",
    ]) {
      expect(await rawGet(origin, path)).toMatchObject({
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: "400 Bad Request",
      });
    }
    expect(await rawGet(origin, "/health?value=%zz")).toMatchObject({
      status: 200,
      contentType: "application/json",
      body: '{"data":true}\n',
    });
  });

  test("translation parameters preserve literal dollar replacement sequences", async () => {
    const { origin } = fixture();
    for (const value of ["$&", "$$", "$`", "$'", "$1", "before $& $$ $` $' after"]) {
      const result = await request(
        origin,
        `/fixture/field/literal?value=${encodeURIComponent(value)}`,
      );
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ message: `Invalid fields: ${value}` });
    }
  });

  test("independent apps and concurrent requests use injected clocks and translations", async () => {
    const firstClock = new TestClock();
    const secondClock = new TestClock();
    const baseLanguage = createTranslation();
    const firstLanguage = baseLanguage.Load({ "fixture.label": "first" });
    const secondLanguage = baseLanguage.Load({ "fixture.label": "second" });
    const first = fixture({ clock: firstClock, i18n: firstLanguage });
    const second = fixture({ clock: secondClock, i18n: secondLanguage });
    let firstFinished = false;
    const a = request(first.origin, "/fixture/clock/a").then((response) => {
      firstFinished = true;
      return response;
    });
    const b = request(first.origin, "/fixture/clock/b");
    const c = request(second.origin, "/fixture/clock/c");
    await Promise.all([firstClock.whenSleeping(2), secondClock.whenSleeping()]);
    firstClock.advance(99);
    secondClock.advance(100);
    expect((await c).body).toBe(
      '{"data":{"id":"c","time":"2026-01-02T03:04:05.100Z","label":"second"}}\n',
    );
    expect(firstFinished).toBe(false);
    firstClock.advance(1);
    expect((await a).body).toBe(
      '{"data":{"id":"a","time":"2026-01-02T03:04:05.100Z","label":"first"}}\n',
    );
    expect((await b).body).toBe(
      '{"data":{"id":"b","time":"2026-01-02T03:04:05.100Z","label":"first"}}\n',
    );
  });

  test("real clock sleep cancels both before and after registration", async () => {
    const { origin } = fixture({ clock: createRealClock() });
    expect((await request(origin, "/fixture/abort/before")).body).toBe('{"data":"AbortError"}\n');
    expect((await request(origin, "/fixture/abort/after")).body).toBe('{"data":"AbortError"}\n');
  });

  test("embedded language packs select the requested overlay and fall back to English", async () => {
    const english = fixture({ i18n: createTranslation("en") });
    const french = fixture({ i18n: createTranslation("fr") });
    const unknown = fixture({ i18n: createTranslation("not-a-language") });
    expect((await request(english.origin, "/fixture/locale")).body).toBe(
      '{"data":{"code":"en","name":"English (en)","message":"Invalid name."}}\n',
    );
    expect((await request(french.origin, "/fixture/locale")).body).toBe(
      '{"data":{"code":"fr","name":"Français (fr)","message":"Le nom entré présente une erreur."}}\n',
    );
    expect((await request(unknown.origin, "/fixture/locale")).body).toBe(
      '{"data":{"code":"en","name":"English (en)","message":"Invalid name."}}\n',
    );
  });

  test("translation overlays, interpolation, plural rules, missing references, and cycles", async () => {
    const language = new Translation(
      {
        "_.code": "en",
        "_.name": "English",
        "fixture.fallback": "English fallback",
        "fixture.count": "one | many",
        "fixture.multi": "one | two | three",
        "fixture.message": "Hello {name}",
        "fixture.reference": "{fixture.inner}",
        "fixture.inner": "friend",
        "fixture.cycle": "{fixture.next}",
        "fixture.next": "{fixture.cycle}",
      },
      { "_.code": "xx", "_.name": "Overlay" },
    );
    const { origin } = fixture({ i18n: language });
    const one = JSON.parse((await request(origin, "/fixture/translations?count=1")).body).data;
    expect(one).toEqual({
      name: "Overlay",
      code: "xx",
      englishFallback: "English fallback",
      missing: "fixture.missing",
      singular: "one",
      count: "one",
      multi: "one",
      substituted: "Hello friend",
      missingReference: "Hello fixture.absent",
      cycle: "Hello {fixture.cycle}",
      invalidArguments: "fixture.message: Invalid arguments",
    });
    const many = JSON.parse((await request(origin, "/fixture/translations?count=2")).body).data;
    expect(many.count).toBe("many");
    const zero = JSON.parse((await request(origin, "/fixture/translations?count=0")).body).data;
    expect(zero.count).toBe("one");
  });
});
