// Exact M2.1 executable creates a disposable v1 DB; candidate upgrades it.
import assert from "node:assert/strict";
import { copyFile, readdir, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
const control = resolve("node_modules/.cache/m22-control/dist/iglo.email");
const candidate = resolve("dist/iglo.email");
const admin = { user: "fixture-admin", password: "fixture-admin-password" };
await withProduction(
  control,
  AbortSignal.timeout(30000),
  async (origin, _signal, restart, dataDir) => {
    const credentials = await provisionApiUser(origin, admin);
    const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
    const headers = { authorization, "content-type": "application/json" };
    let response = await fetch(`${origin}/api/settings/app.site_name`, {
      method: "PUT",
      headers,
      body: JSON.stringify("synthetic-migration"),
    });
    assert.equal(response.status, 200);
    const copy = join(dirname(dataDir), "next-iglo.email");
    await copyFile(candidate, copy);
    await rename(copy, join(dirname(dataDir), "iglo.email"));
    await restart();
    response = await fetch(`${origin}/api/settings`, { headers });
    assert.equal(response.status, 200);
    const settings = ((await response.json()) as { data: Record<string, unknown> }).data;
    assert.equal(settings["app.site_name"], "synthetic-migration");
    assert.equal((await fetch(`${origin}/api/sends`, { headers })).status, 200);
    assert.equal(
      (await readdir(join(dataDir, "backups"))).filter((name) => name.endsWith(".db")).length,
      1,
    );
    const old = spawnSync(
      control,
      ["serve", "--host", "127.0.0.1", "--port", "12345", "--data-dir", dataDir],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /Database version 2 is ahead/);
    await restart();
    assert.equal((await fetch(`${origin}/api/settings`, { headers })).status, 200);
    assert.equal(
      (await readdir(join(dataDir, "backups"))).filter((name) => name.endsWith(".db")).length,
      1,
    );
    process.stdout.write(
      "PASS exact M2.1 upgrade, credential/settings preservation, snapshot and old-binary rejection\n",
    );
  },
  admin,
);
