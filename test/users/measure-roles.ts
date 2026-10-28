// Bounded synthetic production HTTP measurements, separate from ordinary tests.
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";

const root = resolve(import.meta.dir, "../..");
const fixture = await readFile(resolve(root, "test/users/fixtures.md"), "utf8");
const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1];
const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1];
if (!user || !password) throw new Error("Missing synthetic fixture");
const admin = { user, password };
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
function code() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
function cookie(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(";", 1)[0] ?? ""
  );
}
function nonce(html: string) {
  return /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1] ?? "";
}
function mean(samples: number[]) {
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}
for (let repetition = 1; repetition <= 3; repetition++) {
  await withProduction(
    resolve(root, "dist/iglo.email"),
    AbortSignal.timeout(60000),
    async (origin) => {
      async function login() {
        const page = await fetch(`${origin}/admin/login`);
        const response = await fetch(`${origin}/admin/login`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookie(page, "nonce"),
          },
          body: new URLSearchParams({
            username: admin.user,
            password: admin.password,
            nonce: nonce(await page.text()),
            next: "/api/profile",
          }),
        });
        if (response.status !== 302) throw new Error("Login failed");
        return response;
      }
      const initial = await login();
      const session = cookie(initial, "session"),
        csrf = cookie(initial, "csrf").slice(5);
      if (!session || !csrf) throw new Error("Session missing");
      const profile = await fetch(`${origin}/api/profile`, { headers: { cookie: session } });
      const id = ((await profile.json()) as { data: { id: number } }).data.id;
      const headers = { cookie: session, "x-csrf-token": csrf, "content-type": "application/json" };
      async function role() {
        const begin = performance.now();
        const created = await fetch(`${origin}/api/roles/users`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: `measure-${crypto.randomUUID()}`,
            permissions: ["roles:get"],
          }),
        });
        if (created.status !== 200) throw new Error("Role creation failed");
        const roleId = ((await created.json()) as { data: { id: number } }).data.id;
        const updated = await fetch(`${origin}/api/roles/users/${roleId}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ name: `measure-${crypto.randomUUID()}`, permissions: [] }),
        });
        const deleted = await fetch(`${origin}/api/roles/${roleId}`, { method: "DELETE", headers });
        if (updated.status !== 200 || deleted.status !== 200)
          throw new Error("Role mutation failed");
        return performance.now() - begin;
      }
      async function factor() {
        const begin = performance.now();
        const enabled = await fetch(`${origin}/api/users/${id}/twofa`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ secret, code: code() }),
        });
        if (enabled.status !== 200) throw new Error("Factor enable failed");
        const enableMs = performance.now() - begin;
        const loginStart = performance.now();
        const primary = await login();
        const location = primary.headers.get("location") ?? "";
        if (!location.startsWith("/admin/login/twofa?")) throw new Error("Challenge missing");
        const page = await fetch(`${origin}${location}`);
        const parsed = new URL(location, origin);
        const response = await fetch(`${origin}/admin/login/twofa`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookie(page, "nonce"),
          },
          body: new URLSearchParams({
            token: parsed.searchParams.get("token") ?? "",
            next: "/api/profile",
            nonce: nonce(await page.text()),
            totp_code: code(),
          }),
        });
        if (response.status !== 302 || !cookie(response, "session"))
          throw new Error("Factor login failed");
        const loginMs = performance.now() - loginStart;
        const disableStart = performance.now();
        const disabled = await fetch(`${origin}/api/users/${id}/twofa`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ password: admin.password }),
        });
        if (disabled.status !== 200) throw new Error("Factor disable failed");
        return { enableMs, loginMs, disableMs: performance.now() - disableStart };
      }
      await role();
      await factor();
      const roles: number[] = [],
        factors: { enableMs: number; loginMs: number; disableMs: number }[] = [];
      for (let i = 0; i < 3; i++) roles.push(await role());
      for (let i = 0; i < 3; i++) factors.push(await factor());
      process.stdout.write(
        `${JSON.stringify({ repetition, temporaryRoot: tmpdir(), roleCreateUpdateDeleteMeanMs: mean(roles), factorEnableMeanMs: mean(factors.map((v) => v.enableMs)), factorDisableMeanMs: mean(factors.map((v) => v.disableMs)), twoStepLoginMeanMs: mean(factors.map((v) => v.loginMs)) })}\n`,
      );
    },
    admin,
  );
}
