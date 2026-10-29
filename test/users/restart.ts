// Compiled-process acceptance; only disposable HTTP-provisioned data is used.
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";

const admin = { user: "restart-admin", password: "restart-synthetic-password" };
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
function code() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(`FAIL ${name}`);
  process.stdout.write(`PASS ${name}\n`);
}
function cookie(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .find((v) => v.startsWith(`${name}=`))
      ?.split(";", 1)[0] ?? ""
  );
}
await withProduction(
  resolve(import.meta.dir, "../../dist/iglo.email"),
  AbortSignal.timeout(60_000),
  async (origin, _signal, restart) => {
    const notices = [
      "qrcode@1.5.4",
      "dijkstrajs@1.0.3",
      "pngjs@5.0.0",
      "yargs@15.4.1",
      "yargs-parser@18.1.3",
      "y18n@4.0.3",
      "ansi-regex@5.0.1",
      "ansi-styles@4.3.0",
      "camelcase@5.3.1",
      "cliui@6.0.0",
      "color-convert@2.0.1",
      "color-name@1.1.4",
      "decamelize@1.2.0",
      "emoji-regex@8.0.0",
      "find-up@4.1.0",
      "get-caller-file@2.0.5",
      "is-fullwidth-code-point@3.0.0",
      "locate-path@5.0.0",
      "p-limit@2.3.0",
      "p-locate@4.1.0",
      "p-try@2.2.0",
      "path-exists@4.0.0",
      "require-directory@2.1.1",
      "require-main-filename@2.0.0",
      "set-blocking@2.0.0",
      "string-width@4.2.3",
      "strip-ansi@6.0.1",
      "which-module@2.0.1",
      "wrap-ansi@6.2.0",
      "liquidjs@10.30.0",
      "marked@15.0.12",
      "commander@10.0.1",
      "nodemailer@10.2.1",
    ];
    for (const notice of notices) {
      const response = await fetch(`${origin}/admin/static/licenses/${notice}.txt`);
      const text = await response.text();
      check(
        response.status === 200 &&
          text.length > 100 &&
          /copyright|permission|license/i.test(text) &&
          (notice !== "qrcode@1.5.4" || text.includes("Copyright (c) 2012 Ryan Day")),
        `embedded-notice-${notice}`,
      );
    }
    async function passwordLogin() {
      const page = await fetch(`${origin}/admin/login`);
      const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      return fetch(`${origin}/admin/login`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookie(page, "nonce"),
        },
        body: new URLSearchParams({
          username: admin.user,
          password: admin.password,
          nonce,
          next: "/api/profile",
        }),
      });
    }
    async function finish(location: string) {
      const page = await fetch(`${origin}${location}`, { redirect: "manual" });
      if (page.status !== 200) return page;
      const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      return fetch(`${origin}/admin/login/twofa`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookie(page, "nonce"),
        },
        body: new URLSearchParams({
          nonce,
          token: new URL(location, origin).searchParams.get("token") ?? "",
          totp_code: code(),
          next: "/api/profile",
        }),
      });
    }
    const first = await passwordLogin();
    const session = cookie(first, "session"),
      csrf = cookie(first, "csrf");
    const profile = await fetch(`${origin}/api/profile`, { headers: { cookie: session } });
    const id = ((await profile.json()) as { data: { id: number } }).data.id;
    const enabled = await fetch(`${origin}/api/users/${id}/twofa`, {
      method: "PUT",
      headers: {
        cookie: `${session}; ${csrf}`,
        "x-csrf-token": csrf.slice(5),
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret, code: code() }),
    });
    check(enabled.status === 200, "restart-factor-enabled");
    const completeLocation = (await passwordLogin()).headers.get("location") ?? "";
    const completed = await finish(completeLocation);
    const completedSession = cookie(completed, "session");
    check(completed.status === 302 && !!completedSession, "restart-completed-session");
    const pendingLocation = (await passwordLogin()).headers.get("location") ?? "";
    check(pendingLocation.startsWith("/admin/login/twofa?"), "restart-pending-challenge");
    await restart();
    const after = await fetch(`${origin}/api/profile`, { headers: { cookie: completedSession } });
    check(
      after.status === 200 &&
        ((await after.json()) as { data: { twofa_type: string } }).data.twofa_type === "totp",
      "restart-factor-and-session-persist",
    );
    const stale = await finish(pendingLocation);
    check(!cookie(stale, "session") && stale.status === 302, "restart-challenge-rejected");
    const fresh = await finish((await passwordLogin()).headers.get("location") ?? "");
    const freshSession = cookie(fresh, "session");
    check(
      fresh.status === 302 &&
        !!freshSession &&
        (await fetch(`${origin}/api/profile`, { headers: { cookie: freshSession } })).status ===
          200,
      "restart-fresh-login",
    );
  },
  admin,
);
