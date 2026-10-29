// Bounded synthetic compiled HTTP workload for M1.2; no external services.
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
const admin = { user: "m12-measure-admin", password: "m12-measure-password" };
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
for (let repetition = 1; repetition <= 3; repetition++) {
  await withProduction(
    resolve(process.argv[2] ?? "dist/iglo.email"),
    AbortSignal.timeout(120_000),
    async (origin, _signal, restart) => {
      const credential = await provisionApiUser(origin, admin);
      const headers = {
        Authorization: `Basic ${btoa(`${credential.user}:${credential.token}`)}`,
        "Content-Type": "application/json",
      };
      const request = async (path: string, method = "GET", value?: unknown) => {
        const response = await fetch(origin + path, {
          method,
          headers,
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        });
        if (response.status !== 200) throw new Error(`Unexpected HTTP status ${response.status}`);
        return (await response.json()).data;
      };
      const measure = async (count: number, warm: number, action: (i: number) => Promise<void>) => {
        const samples: number[] = [];
        for (let i = 0; i < count + warm; i++) {
          const start = performance.now();
          await action(i);
          if (i >= warm) samples.push(performance.now() - start);
        }
        return mean(samples);
      };
      const health = await measure(50, 5, async () => {
        await request("/health");
      });
      const lists = await measure(50, 5, async () => {
        await request("/api/lists");
      });
      const subscriber = await request("/api/subscribers", "POST", {
        email: "measure@example.test",
      });
      const subscribers = await measure(50, 5, async () => {
        await request(`/api/subscribers/${subscriber.id}`);
      });
      const get = await measure(50, 5, async () => {
        await request("/api/settings");
      });
      const snapshot = await request("/api/settings");
      for (const field of ["smtp", "bounce.mailboxes", "messengers"])
        for (const item of snapshot[field]) item.password = "";
      for (const field of ["upload.s3.aws_secret_access_key", "bounce.sendgrid_key"])
        snapshot[field] = "";
      for (const [field, subfield] of [
        ["bounce.azure", "shared_secret"],
        ["bounce.postmark", "password"],
        ["bounce.forwardemail", "key"],
        ["bounce.lettermint", "key"],
        ["security.oidc", "client_secret"],
      ] as const)
        snapshot[field][subfield] = "";
      snapshot["security.captcha"].hcaptcha.secret = "";
      const full = await measure(20, 5, async (i) => {
        snapshot["app.site_name"] = `measure-${i}`;
        await request("/api/settings", "PUT", snapshot);
      });
      const key = await measure(20, 5, async (i) => {
        await request("/api/settings/app.site_name", "PUT", `key-${i}`);
      });
      const restartMs = await measure(3, 1, async () => {
        await restart();
        await request("/api/settings");
      });
      let sessionCookie = "";
      const sessionLogin = await measure(10, 2, async () => {
        const page = await fetch(origin + "/admin/login");
        const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1];
        const cookie = page.headers
          .getSetCookie()
          .find((value) => value.startsWith("nonce="))
          ?.split(";", 1)[0];
        if (!nonce || !cookie) throw new Error("Missing synthetic login nonce");
        const response = await fetch(origin + "/admin/login", {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
          body: new URLSearchParams({ username: admin.user, password: admin.password, nonce }),
        });
        sessionCookie =
          response.headers
            .getSetCookie()
            .find((value) => value.startsWith("session="))
            ?.split(";", 1)[0] ?? "";
        if (response.status !== 302 || !sessionCookie) throw new Error("Synthetic login failed");
      });
      const sessionRead = await measure(50, 5, async () => {
        const response = await fetch(origin + "/api/profile", {
          headers: { Cookie: sessionCookie },
        });
        if (response.status !== 200) throw new Error("Synthetic session read failed");
        await response.arrayBuffer();
      });
      process.stdout.write(
        `${JSON.stringify({ repetition, health, lists, subscribers, get, full, key, restartMs, sessionLogin, sessionRead })}\n`,
      );
    },
    admin,
    120_000,
  );
}
