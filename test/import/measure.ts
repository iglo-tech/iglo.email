// Serial timing for docs/perf/M1.9-import.md; opt-in, not a CI threshold. Over real HTTP on a
// compiled build: imports of generated rows while one client makes pixel-sized writes and another
// fetches a public page, each in a loop, so the longest round trip is the worst gap either saw.
// Peak memory is the server's VmHWM. The longest write-lock hold cannot be seen from outside, so
// the same batches then run in this process on the real store, each timed around its transaction.
// Usage: bun test/import/measure.ts <executable> <rows>
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createImporter } from "@/subscribers/import/importer";
import { createSubscriberStore } from "@/subscribers/store";
import { createTranslation } from "@/i18n/i18n";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { createWebhookEffects } from "@/webhooks/effects";
import { createWebhookStore } from "@/webhooks/store";

const repository = resolve(import.meta.dir, "../..");
const executable = resolve(process.argv[2] ?? join(repository, "dist/iglo.email"));
const count = Number(process.argv[3] ?? 100_000);
const admin = { user: "measure-admin", password: "measure-admin-password" };
const DUMMY = "00000000-0000-0000-0000-000000000000";

const csv = (label: string, rows: number) => {
  const lines = ["email,name,attributes"];
  for (let i = 0; i < rows; i++)
    lines.push(`${label}${i}@example.test,Person ${i},"{""plan"":""p${i % 7}"",""n"":${i}}"`);
  return `${lines.join("\n")}\n`;
};
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] ?? 0;
const summary = (values: number[]) => ({
  n: values.length,
  p50: +quantile(values, 0.5).toFixed(1),
  p99: +quantile(values, 0.99).toFixed(1),
  max: +Math.max(...values).toFixed(1),
});
const peak = (pid: string) =>
  Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]) / 1024;

async function overHttp() {
  return withProduction(
    executable,
    AbortSignal.timeout(280_000),
    async (origin, _signal, _restart, dataDir) => {
      const pid = Bun.spawnSync(["pgrep", "-f", dataDir]).stdout.toString().trim().split("\n")[0]!;
      const { user, token } = await provisionApiUser(origin, admin);
      const authorization = `Basic ${btoa(`${user}:${token}`)}`;
      const json = async (path: string, method = "GET", body?: unknown) =>
        (
          await (
            await fetch(`${origin}${path}`, {
              method,
              headers: { authorization, "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          ).json()
        ).data;
      const list = await json("/api/lists", "POST", { name: "measure" });
      const campaign = await json("/api/campaigns", "POST", {
        name: "measure",
        subject: "measure",
        lists: [list.id],
        from_email: "a@example.test",
        messenger: "email",
        type: "regular",
        content_type: "richtext",
        body: "x",
      });
      const pixel = `${origin}/campaign/${campaign.uuid}/${DUMMY}/px.png`;
      const page = `${origin}/subscription/form`;
      const probing = async <T>(work: () => Promise<T>) => {
        let running = true;
        const gaps = { pixel: [] as number[], page: [] as number[] };
        const loop = async (url: string, out: number[]) => {
          while (running) {
            const started = performance.now();
            await (await fetch(url)).arrayBuffer();
            out.push(performance.now() - started);
            await Bun.sleep(2);
          }
        };
        const clients = [loop(pixel, gaps.pixel), loop(page, gaps.page)];
        const result = await work();
        running = false;
        await Promise.all(clients);
        return { result, pixel: summary(gaps.pixel), page: summary(gaps.page) };
      };
      const finish = async () => {
        while (true) {
          const status = await json("/api/import/subscribers");
          if (status.status === "finished" || status.status === "failed") return status;
          await Bun.sleep(50);
        }
      };
      const importing = async (params: unknown, content: string) => {
        const form = new FormData();
        form.append("params", JSON.stringify(params));
        form.append("file", new File([content], "measure.csv"));
        const started = performance.now();
        const response = await fetch(`${origin}/api/import/subscribers`, {
          method: "POST",
          headers: { authorization },
          body: form,
        });
        if (response.status !== 200) throw new Error(await response.text());
        const status = await finish();
        const seconds = (performance.now() - started) / 1000;
        await json("/api/import/subscribers", "DELETE");
        return {
          status: status.status,
          imported: status.imported,
          seconds: +seconds.toFixed(2),
          rowsPerSecond: Math.round(status.imported / seconds),
        };
      };
      const subscribe = { mode: "subscribe", delim: ",", lists: [list.id] };
      const out: Record<string, unknown> = {};
      out.idle = await probing(() => Bun.sleep(3000));
      out.hwmBeforeMiB = +peak(pid).toFixed(0);
      const file = csv("person", count);
      out.fresh = await probing(() => importing(subscribe, file));
      out.hwmAfterFreshMiB = +peak(pid).toFixed(0);
      out.overwrite = await probing(() => importing({ ...subscribe, overwrite: true }, file));
      out.hwmAfterOverwriteMiB = +peak(pid).toFixed(0);
      const hook = await json("/api/webhooks", "POST", {
        url: "http://127.0.0.1:9/hook",
        events: ["subscriber.blocklisted", "subscriber.unsubscribed"],
        enabled: false,
      });
      await json(`/api/webhooks/${hook.id}`, "PUT", {
        url: "http://127.0.0.1:9/hook",
        events: ["subscriber.blocklisted", "subscriber.unsubscribed"],
        enabled: true,
      });
      out.blocklist = await probing(() =>
        importing(
          { mode: "blocklist", delim: ",", lists: [] },
          csv("person", Math.min(count, 25_000)),
        ),
      );
      out.hwmAfterBlocklistMiB = +peak(pid).toFixed(0);
      return out;
    },
    admin,
    280_000,
  );
}

/** A file near the upload limit, started and stopped at once: what the upload itself costs. */
async function uploadOnly() {
  return withProduction(
    executable,
    AbortSignal.timeout(120_000),
    async (origin, _signal, _restart, dataDir) => {
      const pid = Bun.spawnSync(["pgrep", "-f", dataDir]).stdout.toString().trim().split("\n")[0]!;
      const { user, token } = await provisionApiUser(origin, admin);
      const authorization = `Basic ${btoa(`${user}:${token}`)}`;
      const headers = { authorization, "content-type": "application/json" };
      const list = (
        await (
          await fetch(`${origin}/api/lists`, {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "measure" }),
          })
        ).json()
      ).data;
      const form = new FormData();
      form.append("params", JSON.stringify({ mode: "subscribe", delim: ",", lists: [list.id] }));
      const line = "someone.with.a.long.address@example.test,A Name,\n";
      form.append(
        "file",
        new File(
          [`email,name,attributes\n${line.repeat(Math.floor(99_000_000 / line.length))}`],
          "big.csv",
        ),
      );
      const before = peak(pid);
      const started = performance.now();
      const response = await fetch(`${origin}/api/import/subscribers`, {
        method: "POST",
        headers: { authorization },
        body: form,
      });
      const seconds = (performance.now() - started) / 1000;
      if (response.status !== 200) throw new Error(await response.text());
      await fetch(`${origin}/api/import/subscribers`, { method: "DELETE", headers });
      return {
        seconds: +seconds.toFixed(2),
        hwmBeforeMiB: +before.toFixed(0),
        hwmAfterMiB: +peak(pid).toFixed(0),
      };
    },
    admin,
    120_000,
  );
}

/** The real store and importer with each batch's transaction timed. */
async function lockHolds() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-import-measure-"));
  try {
    const clock = createRealClock();
    const db = openDatabase(directory);
    runMigrations(db, directory, clock, productionMigrations);
    const lists = createListReferences(db);
    const webhooks = createWebhookStore(db, clock);
    let store: ReturnType<typeof createSubscriberStore>;
    const effects = createWebhookEffects(webhooks, () => store);
    store = createSubscriberStore(db, clock, lists, {
      blocklisted() {},
      unsubscribed() {},
      ...effects.subscriberEffects,
    });
    const holds: number[] = [];
    const timed =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        const started = performance.now();
        fn(...args);
        holds.push(performance.now() - started);
      };
    const importer = createImporter({
      dataDir: directory,
      clock,
      logger: { error: console.error },
      i18n: createTranslation(),
      store: {
        importSubscribe: timed<Parameters<typeof store.importSubscribe>>(store.importSubscribe),
        importBlocklist: timed<Parameters<typeof store.importBlocklist>>(store.importBlocklist),
        importUnsubscribing: store.importUnsubscribing,
        admitImport: store.admitImport,
      },
      touchLists() {},
      domainPolicy: () => ({ allow: [], block: [] }),
    });
    await importer.sweep();
    db.run("INSERT INTO lists (uuid, name, type, optin) VALUES ('l', 'l', 'private', 'single')");
    const listId = (db.query("SELECT id FROM lists").get() as { id: bigint }).id;
    const go = async (mode: "subscribe" | "blocklist", overwrite: boolean, rows: number) => {
      holds.length = 0;
      const slot = importer.reserve()!;
      writeFileSync(slot.path, csv("person", rows));
      importer.start(slot, {
        name: "m.csv",
        mode,
        status: "unconfirmed",
        overwriteUserInfo: overwrite,
        overwriteStatus: overwrite,
        delimiter: 44,
        listIds: [listId],
      });
      await slot.release();
      while (importer.status().status === "importing") await Bun.sleep(20);
      const result = importer.status();
      if (result.status !== "finished") throw new Error(importer.logs());
      importer.stop();
      return { batches: holds.length, holdMs: summary(holds) };
    };
    const result = {
      fresh: await go("subscribe", false, count),
      overwrite: await go("subscribe", true, count),
      blocklist: await go("blocklist", false, Math.min(count, 25_000)),
    };
    await importer.close();
    webhooks.close();
    store!.close();
    lists.close();
    db.close(true);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const mode = process.argv[4] ?? "all";
const report: Record<string, unknown> = { rows: count };
if (mode === "all" || mode === "http") report.http = await overHttp();
if (mode === "all" || mode === "upload") report.upload = await uploadOnly();
if (mode === "all" || mode === "locks") report.locks = await lockHolds();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
