// Compiled-process acceptance for the settings backlog line "empty values" (B10, decision D76):
// a settings write that stores an empty `app.lang` or `upload.provider` is accepted, as upstream
// accepts it, and the next start does not fail: it serves English and refuses uploads.
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const admin = { user: "empty-values-admin", password: "empty-values-synthetic-password" };
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(`FAIL ${name}`);
  process.stdout.write(`PASS ${name}\n`);
}
await withProduction(
  resolve(process.argv[2] ?? "dist/iglo.email"),
  AbortSignal.timeout(90_000),
  async (origin, _signal, restart) => {
    const credential = await provisionApiUser(origin, admin);
    const headers = {
      Authorization: `Basic ${btoa(`${credential.user}:${credential.token}`)}`,
      "Content-Type": "application/json",
    };
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(origin + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const current = (await (await api("/api/settings")).json()).data;
    const put = await api("/api/settings", "PUT", {
      ...current,
      "app.lang": "",
      "upload.provider": "",
    });
    check(put.status === 200, "empty-values-accepted");
    await restart();
    const health = await fetch(`${origin}/health`);
    check(health.status === 200, "restart-after-empty-values");
    const after = (await (await api("/api/settings")).json()).data;
    check(after["app.lang"] === "" && after["upload.provider"] === "", "empty-values-kept");
    const login = await (await fetch(`${origin}/admin/login`)).text();
    check(/Login|Username/i.test(login) && !/\.users\./.test(login), "english-fallback");
    const upload = await fetch(`${origin}/api/media`, {
      method: "POST",
      headers: { Authorization: headers.Authorization },
      body: (() => {
        const form = new FormData();
        form.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
        return form;
      })(),
    });
    check(upload.status === 400, "uploads-refused");
  },
  admin,
);
