// Bounded, opt-in measurements against fresh compiled, disk-backed processes.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const fixture = await readFile(resolve(repository, "test/users/fixtures.md"), "utf8");
const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1];
const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1];
if (!user || !password) throw new Error("Synthetic measurement credentials are missing");
const admin = { user, password };
const executable = resolve(repository, "dist/iglo.email");
const signal = AbortSignal.timeout(180_000);

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
async function health(origin: string, path: string, authorization?: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: authorization ? { authorization } : {},
  });
  if (response.status !== 200 || (await response.text()) !== '{"data":true}\n')
    throw new Error("Health measurement failed");
}
async function measuredHealth(
  origin: string,
  path: string,
  authorization?: string,
): Promise<number> {
  const started = performance.now();
  for (let i = 0; i < 80; i++) await health(origin, path, authorization);
  return (performance.now() - started) / 80;
}
async function loginLogout(
  origin: string,
): Promise<{ page: number; login: number; logout: number }> {
  let started = performance.now();
  const page = await fetch(`${origin}/admin/login`);
  const text = await page.text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(text)?.[1];
  const nonceCookie = page.headers
    .getSetCookie()
    .find((item) => item.startsWith("nonce="))
    ?.split(";", 1)[0];
  const pageTime = performance.now() - started;
  if (!nonce || !nonceCookie) throw new Error("Login page measurement failed");
  started = performance.now();
  const response = await fetch(`${origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
    body: new URLSearchParams({
      username: admin.user,
      password: admin.password,
      nonce,
      next: "/api/profile",
    }),
  });
  const loginTime = performance.now() - started;
  const session = response.headers
    .getSetCookie()
    .find((item) => item.startsWith("session="))
    ?.split(";", 1)[0];
  const csrf = response.headers
    .getSetCookie()
    .find((item) => item.startsWith("csrf="))
    ?.split(";", 1)[0];
  if (response.status !== 302 || !session || !csrf) throw new Error("Login measurement failed");
  started = performance.now();
  const logout = await fetch(`${origin}/api/logout`, {
    method: "POST",
    headers: { cookie: `${session}; ${csrf}`, "x-csrf-token": csrf.slice(5) },
  });
  await logout.text();
  const logoutTime = performance.now() - started;
  if (logout.status !== 200) throw new Error("Logout measurement failed");
  return { page: pageTime, login: loginTime, logout: logoutTime };
}

for (let repetition = 1; repetition <= 3; repetition++) {
  let started = performance.now();
  let unprovisioned = 0;
  await withProduction(executable, signal, async (origin) => {
    unprovisioned = performance.now() - started;
    await health(origin, "/health");
  });
  started = performance.now();
  await withProduction(
    executable,
    signal,
    async (origin) => {
      const bootstrapped = performance.now() - started;
      const credential = await provisionApiUser(origin, admin);
      const authorization = `token ${credential.user}:${credential.token}`;
      for (let i = 0; i < 5; i++) {
        await health(origin, "/health");
        await health(origin, "/api/health", authorization);
      }
      const plain = await measuredHealth(origin, "/health");
      const protectedTime = await measuredHealth(origin, "/api/health", authorization);
      // One warmup followed by three serial password verifications and SQLite sessions.
      await loginLogout(origin);
      const samples = [];
      for (let i = 0; i < 3; i++) samples.push(await loginLogout(origin));
      process.stdout.write(
        JSON.stringify({
          repetition,
          startupUnprovisionedMs: unprovisioned,
          startupBootstrapMs: bootstrapped,
          publicHealthMeanMs: plain,
          protectedHealthMeanMs: protectedTime,
          loginPageMeanMs: mean(samples.map((item) => item.page)),
          passwordLoginSessionMeanMs: mean(samples.map((item) => item.login)),
          logoutMeanMs: mean(samples.map((item) => item.logout)),
        }) + "\n",
      );
    },
    admin,
  );
}
