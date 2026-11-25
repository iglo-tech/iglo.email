// B129 (D127, review blocker 1) and B130 (D128): an install from before this release keeps the built-in
// templates with the product credit, since the store seeds only an empty database. Through the compiled
// executable: a first start seeds the bodies a fresh install gets; then the data directory is put back
// to an earlier release's state (schema 26, its three seeded bodies, and one archive copy edited by one
// byte). The next start runs migrations 27 to 30. The seeded copies then hold this release's bodies
// (the sample transactional template takes the brand, B130), the edited copy keeps its body, and an
// archived campaign on the migrated template renders with no credit and with the site's brand.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureProductionBuild } from "@/test/production-build";
import { asBody, readJson } from "@/test/read-body";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";

const repository = resolve(import.meta.dir, "../..");
setDefaultTimeout(60_000);
const names = {
  campaign: "Default campaign template",
  archive: "Default archive template",
  sample: "Sample transactional template",
};
const edited = "Edited archive copy";
// The credit as a reader sees it. A stored body keeps listmonk's "Adapted from" comment, which
// Liquid never outputs, so a stored body is checked for the credit line and the product's link.
const credit = /Powered by|poweredBy|listmonk/i;
const storedCredit = /Powered by|poweredBy|listmonk\.app/i;
const tokenAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const apiUser = "credit-api";
const token = Array.from(
  crypto.getRandomValues(new Uint8Array(48)),
  (byte) => tokenAlphabet[byte % 62],
).join("");
let temporaryDirectory = "";
let executable = "";
let adminUser = "";
let adminPassword = "";

beforeAll(async () => {
  const fixture = await Bun.file(join(repository, "test/bootstrap/fixtures.md")).text();
  adminUser = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1] ?? "";
  adminPassword = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1] ?? "";
  if (!adminUser || !adminPassword) {
    throw new Error("Bootstrap test credentials are missing");
  }
  await ensureProductionBuild();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-credit-"));
  executable = join(temporaryDirectory, "iglo.email");
  await copyFile(join(repository, "dist", "iglo.email"), executable);
  await chmod(executable, 0o755);
}, 60_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

/** The executable with a clean environment, on port 0 (D144): it names the port the OS gave it. */
function start(dataDir: string) {
  const args = ["--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir];
  return Bun.spawn([executable, ...args], {
    cwd: temporaryDirectory,
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: adminUser,
      IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
      IGLO_EMAIL_API_USER: apiUser,
      IGLO_EMAIL_API_TOKEN: token,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A started process, healthy on its port. */
async function up(dataDir: string) {
  const child = start(dataDir);
  const { port } = await readyOnPortZero(child, 30_000);
  return { child, port };
}

/** An API call as the API user. */
async function api(port: number, method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `token ${apiUser}:${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: (await readJson<{ data: any }>(response)).data };
}

/** Every template by name, with its stored body. */
async function templates(port: number) {
  const rows = asBody<Array<{ id: number; name: string }>>(
    (await api(port, "GET", "/api/templates")).data,
  );
  const byName = new Map<string, { id: number; body: string; is_default: boolean }>();
  for (const row of rows) {
    const full = (await api(port, "GET", `/api/templates/${row.id}`)).data;
    byName.set(row.name, { id: row.id, body: full.body, is_default: full.is_default });
  }
  return byName;
}

/** The earlier release's seeded body, as this test's fixture holds it. */
const earlier = (file: string) => Bun.file(join(import.meta.dir, "earlier-templates", file)).text();

function userVersion(dataDir: string): number {
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"), { readonly: true });
  try {
    const row = asBody<{ user_version: number }>(db.query("PRAGMA user_version").get());
    return Number(row.user_version);
  } finally {
    db.close(true);
  }
}

test("a seeded install from before this release takes the migrated bodies, and an edited copy keeps its body", async () => {
  const dataDir = join(temporaryDirectory, crypto.randomUUID());
  // This release's first start seeds what a fresh install gets.
  const first = await up(dataDir);
  let seeded: Awaited<ReturnType<typeof templates>>;
  try {
    seeded = await templates(first.port);
  } finally {
    await stopChild(first.child);
  }
  for (const name of Object.values(names)) {
    expect(seeded.get(name)?.body).toBeString();
    expect(seeded.get(name)?.body).not.toMatch(storedCredit);
  }

  // An earlier release's data: its three seeded bodies and an archive copy edited by one byte.
  const oldArchive = await earlier("default-archive.tpl.txt");
  const copy = oldArchive.replace("color: #444;", "color: #445;");
  expect(copy.length).toBe(oldArchive.length);
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"), {
    readwrite: true,
    strict: true,
  });
  try {
    for (const [name, file] of [
      [names.campaign, "default.tpl.txt"],
      [names.archive, "default-archive.tpl.txt"],
      [names.sample, "sample-tx.tpl.txt"],
    ] as const) {
      db.run("UPDATE templates SET body = ? WHERE name = ?", [await earlier(file), name]);
    }
    db.run(
      "INSERT INTO templates (name, type, subject, body, body_source, is_default) VALUES (?, 'campaign', '', ?, NULL, 0)",
      [edited, copy],
    );
    // Schema 26 keeps the webhook migration (0026) applied; at 25 it would run again and fail on its column.
    // Schema 26 also has the send status index that migration 28 replaces, so it is put back here.
    db.run("DROP INDEX idx_sends_status_id");
    db.run("CREATE INDEX idx_sends_outbox ON sends(status, created_at)");
    // Schema 26 has no enrollment exit condition either (migration 29, B127 r2), so it is dropped here.
    db.run("ALTER TABLE enrollments DROP COLUMN exit_condition");
    // Migration 31 (B117d) names each send; schema 26 has no such columns.
    db.run("ALTER TABLE sends DROP COLUMN template_name");
    db.run("ALTER TABLE sends DROP COLUMN sequence_name");
    // Migration 34 (B141) indexes due sends by kind; the earlier schema has no such index.
    db.run("DROP INDEX idx_sends_due_kind");
    // Migration 32 (B140) marks the admin's copy; the earlier schema has no such column.
    db.run("DROP INDEX users_one_admin_copy");
    db.run("ALTER TABLE users DROP COLUMN admin_copy");
    db.run("PRAGMA user_version = 26");
  } finally {
    db.close(true);
  }

  // The next start runs migrations 27 to 30.
  const second = await up(dataDir);
  try {
    const after = await templates(second.port);
    expect(userVersion(dataDir)).toBe(34);
    expect(after.get(names.campaign)?.body).toBe(seeded.get(names.campaign)?.body);
    expect(after.get(names.archive)?.body).toBe(seeded.get(names.archive)?.body);
    expect(after.get(names.sample)?.body).toBe(seeded.get(names.sample)?.body);
    // Names, ids and the default flag are untouched.
    expect(after.get(names.campaign)?.id).toBe(seeded.get(names.campaign)?.id);
    expect(after.get(names.campaign)?.is_default).toBe(true);
    expect(after.get(edited)?.body).toBe(copy);

    // An archived campaign on the migrated archive template, with the brand set.
    const list = await api(second.port, "POST", "/api/lists", {
      name: "Archive readers",
      type: "public",
      optin: "single",
    });
    expect(list.status).toBe(200);
    expect(
      (await api(second.port, "PUT", "/api/settings/app.enable_public_archive", true)).status,
    ).toBe(200);
    expect(
      (await api(second.port, "PUT", "/api/settings/appearance.brand.accent", "#ff0066")).status,
    ).toBe(200);
    const campaign = await api(second.port, "POST", "/api/campaigns", {
      name: "Credit check",
      subject: "Credit check",
      lists: [list.data.id],
      from_email: "Newsletter <noreply@example.com>",
      content_type: "richtext",
      body: "<p>Archived body</p>",
      messenger: "email",
      template_id: after.get(names.campaign)?.id,
      archive: true,
      archive_slug: "credit-check",
      archive_template_id: after.get(names.archive)?.id,
      archive_meta: { name: "Reader", email: "reader@example.test" },
    });
    expect(campaign.status).toBe(200);
    // Creating a campaign copies its template into the archive template (upstream's rule), so the
    // migrated archive layout is set the way the admin screen sets it: on the archive endpoint.
    const archived = await api(second.port, "PUT", `/api/campaigns/${campaign.data.id}/archive`, {
      archive: true,
      archive_template_id: after.get(names.archive)?.id,
      archive_slug: "credit-check",
      archive_meta: { name: "Reader", email: "reader@example.test" },
    });
    expect(archived.status).toBe(200);
    expect((await api(second.port, "PUT", "/api/settings/app.site_name", "Brand Co")).status).toBe(
      200,
    );
    // The archive publishes only a sent campaign, and this test sends nothing: its state is set the
    // way a finished send leaves it.
    const sent = new Database(join(dataDir, "projects", "main", "iglo-email.db"), {
      readwrite: true,
      strict: true,
    });
    try {
      sent.run("UPDATE campaigns SET status = 'finished' WHERE archive_slug = 'credit-check'");
    } finally {
      sent.close(true);
    }
    const page = await fetch(`http://127.0.0.1:${second.port}/archive/credit-check`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Archived body");
    expect(html).not.toMatch(credit);
    expect(html).toContain("#ff0066");
    // The migrated archive layout is the one rendered: its header shows the site's name.
    expect(html).toContain("Brand Co");
  } finally {
    await stopChild(second.child);
  }
});
