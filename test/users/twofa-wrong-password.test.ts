// A wrong password on the two-factor change answers 403 with the code of a wrong credential (D138),
// and changes nothing. Through HTTP on the user fixture, as the admin session does it.
import { afterEach, expect, test } from "bun:test";
import { startUserFixture } from "@/test/users/fixture";
import { readJson } from "@/test/read-body";

type Fixture = Awaited<ReturnType<typeof startUserFixture>>;
const fixtures: Array<Fixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});

async function admin(f: Fixture) {
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie = page.headers
    .getSetCookie()
    .find((v) => v.startsWith("nonce="))!
    .split(";")[0]!;
  const r = await fetch(`${f.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: nonceCookie,
    },
    body: new URLSearchParams({
      username: f.admin.user,
      password: f.admin.password,
      nonce,
    }),
  });
  const h = r.headers.getSetCookie();
  const session = h.find((v) => v.startsWith("session="))!.split(";")[0]!;
  const csrf = h.find((v) => v.startsWith("csrf="))!.split(";")[0]!;
  return { cookie: `${session}; ${csrf}`, csrf: csrf.slice(5) };
}

async function call(
  f: Fixture,
  s: { cookie: string; csrf: string },
  path: string,
  method = "GET",
  body?: unknown,
) {
  return fetch(`${f.origin}${path}`, {
    method,
    headers: {
      cookie: s.cookie,
      "x-csrf-token": s.csrf,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("a wrong password on the two-factor change is 403 invalid_credentials, and nothing changes", async () => {
  const f = await startUserFixture();
  fixtures.push(f);
  const s = await admin(f);
  const id = (await readJson<{ data: { id: number } }>(await call(f, s, "/api/profile"))).data.id;
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  expect(
    (await call(f, s, `/api/users/${id}/twofa`, "PUT", { secret, code: "391022" })).status,
  ).toBe(200);

  const wrong = await call(f, s, `/api/users/${id}/twofa`, "DELETE", {
    password: "not-the-admin-password",
  });
  expect(wrong.status).toBe(403);
  expect(await readJson<{ message: string; code: string }>(wrong)).toMatchObject({
    code: "invalid_credentials",
  });

  const still = await readJson<{ data: { twofa_type: string } }>(
    await call(f, s, `/api/users/${id}`),
  );
  expect(still.data.twofa_type).toBe("totp");
});
