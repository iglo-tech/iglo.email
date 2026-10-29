// Native D53 production boundary, independent of the upstream parity corpus.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const admin = { user: "fixture-admin", password: "fixture-admin-password" };
await withProduction(
  resolve("dist/iglo.email"),
  AbortSignal.timeout(30000),
  async (origin, _signal, restart) => {
    const credentials = await provisionApiUser(origin, admin);
    const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
    const call = (path: string, auth = authorization) =>
      fetch(`${origin}${path}`, { headers: auth ? { authorization: auth } : {} });
    assert.equal((await call("/api/sends", "")).status, 403);
    let response = await call("/api/sends");
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { data: unknown }).data, {
      results: [],
      total: 0,
      page: 1,
      per_page: 20,
    });
    for (const path of [
      "/api/sends?page=0",
      "/api/sends?per_page=101",
      "/api/sends?status=no",
      "/api/sends/9223372036854775808",
    ])
      assert.equal((await call(path)).status, 400);
    assert.equal((await call("/api/sends/42")).status, 404);
    await restart();
    response = await call("/api/sends");
    assert.equal(response.status, 200);
    assert.deepEqual(
      ((await response.json()) as { data: { results: unknown[] } }).data.results,
      [],
    );
    process.stdout.write("PASS native production empty journal, authentication and restart\n");
  },
  admin,
);
