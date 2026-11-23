// B117d (D139): the upgrade adds the name columns and rewrites no send. A send an older schema holds shows
// its live template and sequence names until they are deleted, as before; a send queued after the upgrade
// keeps its names once they are deleted (tx and sequence tests cover that path).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { txFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";
import { TestClock } from "@/test/server/fixture";

/** The migration that adds the name columns to the sends (B117d). Sends before it carry no stored name. */
const NAMES_VERSION = 31;

test("an upgrade keeps the sends it holds: their live names show until deleted, and nothing is rewritten", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iglo-send-names-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  try {
    runMigrations(
      db,
      directory,
      clock,
      productionMigrations.filter((migration) => migration.version < NAMES_VERSION),
    );
    db.run(
      "INSERT INTO templates (name, type, subject, body, is_default) VALUES ('Default', 'campaign', 'Subject', '<p>d</p>', 1)",
    );
    db.run(
      "INSERT INTO templates (name, type, subject, body) VALUES ('Old template', 'tx', 'Subject', '<p>x</p>')",
    );
    db.run(
      `INSERT INTO sequences (uuid, name, trigger) VALUES ('old-sequence', 'Old sequence', '{"event":"signup"}')`,
    );
    db.run(
      "INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind) VALUES ('old-step', (SELECT max(id) FROM sequences), 0, 'PT0S', 'transactional')",
    );
    db.run(
      "INSERT INTO sends (uuid, source, kind, to_email, template_id, status, smtp_message_id) VALUES ('old-tx', 'tx', 'transactional', 'tx@example.test', (SELECT max(id) FROM templates), 'sent', '<tx@measure.test>')",
    );
    db.run(
      "INSERT INTO sends (uuid, source, kind, to_email, step_id, status, smtp_message_id) VALUES ('old-seq', 'sequence', 'transactional', 'seq@example.test', (SELECT max(id) FROM sequence_steps), 'sent', '<seq@measure.test>')",
    );
    db.run(
      "INSERT INTO sends (uuid, source, kind, to_email, status, smtp_message_id) VALUES ('old-none', 'tx', 'transactional', 'none@example.test', 'sent', '<none@measure.test>')",
    );
  } finally {
    db.close(true);
  }

  const f = await txFixture({ persisted: { dataDir: directory } });
  try {
    const listed = asBody<{ results: Array<Record<string, unknown>> }>(
      (await f.json("/api/sends?per_page=100")).body.data,
    ).results;
    const byAddress = (address: string) => listed.find((row) => row.to_email === address)!;
    expect(byAddress("tx@example.test")).toMatchObject({ template_name: "Old template" });
    expect(byAddress("seq@example.test")).toMatchObject({ sequence_name: "Old sequence" });
    expect(byAddress("none@example.test")).toMatchObject({
      template_name: null,
      sequence_name: null,
    });

    // The template is deleted: its old send has no template left to name it, as before the upgrade.
    const template = byAddress("tx@example.test").template_id;
    expect((await f.json(`/api/templates/${template}`, "DELETE")).status).toBe(200);
    const after = asBody<{ results: Array<Record<string, unknown>> }>(
      (await f.json("/api/sends?per_page=100")).body.data,
    ).results;
    expect(after.find((row) => row.to_email === "tx@example.test")).toMatchObject({
      template_id: null,
      template_name: null,
    });
  } finally {
    await f.close();
  }
});
