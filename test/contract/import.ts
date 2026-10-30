// Reference: listmonk cmd/import.go, internal/subimporter/importer.go and queries/subscribers.sql
// at 6fcd95f. The shared corpus runs against both targets. Where this project differs deliberately
// (07-api-and-ui.md) the check is on `reference`; what only production has follows `if (reference)`.
import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Credentials, Mode } from "@/test/contract/types";
import { startReceiver } from "@/test/webhooks/receiver";

const IDLE = { name: "", total: 0, imported: 0, status: "none" };

export async function runImportContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  dataDir?: string;
}) {
  const reference = target.mode === "reference";
  const suffix = crypto.randomUUID().slice(0, 8);
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL import-${label}`);
  };
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { authorization },
  ) => {
    const form = body instanceof FormData;
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined || form ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: form ? (body as FormData) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* Not JSON. */
    }
    return { status: response.status, body: parsed, text };
  };
  const form = (params: unknown, content?: BlobPart, name = "subscribers.csv") => {
    const data = new FormData();
    if (params !== undefined)
      data.append("params", typeof params === "string" ? params : JSON.stringify(params));
    if (content !== undefined) data.append("file", new File([content], name));
    return data;
  };
  const post = (params: unknown, content?: BlobPart, name?: string, headers?: any) =>
    call("/api/import/subscribers", "POST", form(params, content, name), headers);
  const status = async () => (await call("/api/import/subscribers")).body.data;
  const logs = async () => (await call("/api/import/subscribers/logs")).body.data as string;
  const reset = () => call("/api/import/subscribers", "DELETE");
  const settled = async () => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(20)) {
      const current = await status();
      if (current.status === "finished" || current.status === "failed") return current;
    }
    throw new Error("FAIL import-did-not-settle");
  };
  const run = async (params: unknown, content: BlobPart, name?: string) => {
    const started = await post(params, content, name);
    check(started.status === 200, `start-${started.status}-${started.text}`);
    const done = await settled();
    const log = await logs();
    check((await reset()).status === 200, "reset");
    return { ...done, log };
  };
  const created: number[] = [];
  const lists: number[] = [];
  const roles: number[] = [];
  const users: number[] = [];
  const list = async (label: string) => {
    const result = await call("/api/lists", "POST", { name: `${label}-${suffix}` });
    check(result.status === 200, "list");
    lists.push(result.body.data.id);
    return result.body.data.id as number;
  };
  const address = (label: string) => `${label}.${suffix}@example.test`;
  const subscriber = async (email: string) => {
    const query = encodeURIComponent(`subscribers.email = '${email}'`);
    const found = await call(`/api/subscribers?query=${query}`);
    const row = found.body.data.results[0];
    if (row && !created.includes(row.id)) created.push(row.id);
    return row;
  };
  const membership = (row: any, id: number) =>
    row.lists.find((entry: any) => entry.id === id)?.subscription_status;
  const seed = async (email: string, body: Record<string, unknown>) => {
    const result = await call("/api/subscribers", "POST", { email, ...body });
    check(result.status === 200, "seed");
    created.push(result.body.data.id);
    return result.body.data;
  };
  const subscribe = (ids: number[], extra: Record<string, unknown> = {}) => ({
    mode: "subscribe",
    delim: ",",
    lists: ids,
    ...extra,
  });

  try {
    check((await reset()).status === 200, "idle-reset");
    check(JSON.stringify(await status()) === JSON.stringify(IDLE), "idle-status");
    check((await logs()) === "", "idle-logs");
    check((await call("/api/import/subscribers", "GET", undefined, {})).status === 403, "anon");

    const a = await list("a");
    const b = await list("b");

    // Parameters, in upstream's order.
    const refused = async (result: Awaited<ReturnType<typeof post>>, code: number, text: string) =>
      check(result.status === code && result.body?.message?.includes(text), `refused-${text}`);
    await refused(await post("not json", "email\n"), 400, "Invalid params");
    await refused(await post(undefined, "email\n"), 400, "Invalid params");
    await refused(
      await post({ ...subscribe([a]), lists: ["1"] }, "email\n"),
      400,
      "Invalid params",
    );
    await refused(await post(subscribe([]), "email\n"), 403, "Permission denied: lists");
    await refused(await post({ delim: "," }, "email\n"), 403, "Permission denied: lists");
    await refused(await post({ ...subscribe([a]), mode: "x" }, "email\n"), 400, "Invalid mode");
    await refused(
      await post({ ...subscribe([]), mode: "x", lists: [a] }, "email\n"),
      400,
      "Invalid mode",
    );
    await refused(
      await post(subscribe([a], { subscription_status: "x" }), "email\n"),
      400,
      "Invalid subscription status",
    );
    await refused(
      await post(subscribe([a], { delim: ",," }), "email\n"),
      400,
      "Delimiter should be a single character.",
    );
    await refused(
      await post(subscribe([a], { delim: "" }), "email\n"),
      400,
      "Delimiter should be a single character.",
    );
    await refused(await post(subscribe([a])), 400, "Invalid file");
    check(JSON.stringify(await status()) === JSON.stringify(IDLE), "refused-changes-nothing");

    // A clean file: order of columns, unknown columns, attributes, default name, list status.
    const clean = await run(
      subscribe([a, b], { subscription_status: "confirmed" }),
      [
        "notes,name,email,attributes",
        `x,"Quoted, Name",${address("Clean")},"{""city"":""Kraków"",""n"":1}"`,
        `y,,${address("first.last")},`,
        "",
      ].join("\r\n"),
    );
    check(
      clean.status === "finished" && clean.total === 2 && clean.imported === 2,
      `clean-${JSON.stringify(clean)}`,
    );
    check(clean.name === "subscribers.csv", "clean-name");
    check(clean.log.includes("processing 'subscribers.csv'"), "clean-log-file");
    check(clean.log.includes("ignoring unknown header 'notes'"), "clean-log-header");
    check(clean.log.includes("imported finished"), "clean-log-end");
    check(JSON.stringify(await status()) === JSON.stringify(IDLE), "reset-clears");
    check((await logs()) === "", "reset-clears-log");
    const first = await subscriber(address("clean"));
    check(first?.name === "Quoted, Name", "clean-stored-name");
    check(first?.status === "enabled", "clean-stored-status");
    check(first?.attribs.city === "Kraków" && first.attribs.n === 1, "clean-stored-attribs");
    check(
      membership(first, a) === "confirmed" && membership(first, b) === "confirmed",
      "clean-lists",
    );
    const second = await subscriber(address("first.last"));
    check(second?.name.startsWith("First Last"), `clean-default-name-${second?.name}`);
    check(JSON.stringify(second.attribs) === "{}", "clean-default-attribs");

    // Search and list counts see the new rows.
    const found = await call(`/api/subscribers?search=${encodeURIComponent(address("clean"))}`);
    check(found.body.data.total === 1, "search");
    const counted = (await call(`/api/lists?per_page=all`)).body.data.results.find(
      (entry: any) => entry.id === a,
    );
    check(counted.subscriber_count === 2, `list-count-${counted.subscriber_count}`);
    check(counted.subscriber_statuses?.confirmed === 2, "list-statuses");

    // Defaults, delimiter, BOM, header spacing, blank lines, a duplicate within the file.
    const delimited = await run(
      subscribe([a], { delim: ";" }),
      [
        `\ufeffemail ;name`,
        "",
        `${address("dup").toUpperCase()};First`,
        `${address("dup")};Second`,
        "",
      ].join("\n"),
      "Delimited.CSV",
    );
    check(delimited.status === "finished" && delimited.imported === 2, `delim-${delimited.log}`);
    check(delimited.name === "Delimited.CSV", "delimited-name");
    const dup = await subscriber(address("dup"));
    check(dup.name === "First" && membership(dup, a) === "unconfirmed", "duplicate-first-wins");

    // Bad rows are skipped and logged; a bad attribute cell costs only the attributes.
    const bytes = (...parts: (string | number[])[]) =>
      Buffer.concat(
        parts.map((part) => (typeof part === "string" ? Buffer.from(part) : Buffer.from(part))),
      );
    const rows = await run(
      subscribe([a]),
      bytes(
        "email,name,attributes\n",
        "not-an-email,x,\n",
        `${address("short")},x\n`,
        `${address("long")},x,,extra\n`,
        `${address("binary")},`,
        [0xff, 0xfe],
        ",\n",
        `${address("nul")},a\0b,\n`,
        `${address("badjson")},x,{not json}\n`,
        `${address("array")},x,[1]\n`,
        `${address("good")},x,\n`,
      ),
    );
    check(rows.status === "finished" && rows.total === 8, `rows-${JSON.stringify(rows)}`);
    check(rows.imported === 3, `rows-imported-${rows.imported}`);
    check(rows.log.includes("skipping line 1"), "rows-log-email");
    check(rows.log.includes("skipping line 2"), "rows-log-short");
    check(rows.log.includes("skipping line 3"), "rows-log-long");
    check(rows.log.includes("skipping line 4"), "rows-log-binary");
    check(rows.log.includes("skipping line 5"), "rows-log-nul");
    check(rows.log.includes("skipping invalid attributes JSON on line 6"), "rows-log-attribs");
    for (const label of ["short", "long", "binary", "nul"])
      check(!(await subscriber(address(label))), `rows-absent-${label}`);
    for (const label of ["badjson", "array", "good"]) {
      const row = await subscriber(address(label));
      check(row && Object.keys(row.attribs ?? {}).length === 0, `rows-present-${label}`);
    }

    // A bad file fails the import.
    for (const [label, content] of [
      ["no-email", "name,attributes\nA,\n"],
      ["empty", ""],
      ["blank", "\n\n"],
      ["bare-quote", `email,name\n${address("q1")},a"b\n`],
      ["open-quote", `email,name\n${address("q2")},"never closed\n`],
    ] as const) {
      const failed = await run(subscribe([a]), content);
      check(failed.status === "failed", `bad-file-${label}-${failed.status}`);
      check(failed.imported === 0, `bad-file-${label}-imported`);
    }
    check(!(await subscriber(address("q1"))), "bad-file-wrote-nothing");

    // Consent: without overwrite nothing is re-enabled.
    await seed(address("blocked"), { lists: [a], status: "blocklisted" });
    const left = await seed(address("left"), { lists: [a], name: "Left", attribs: { keep: 1 } });
    const put = await call("/api/subscribers/lists", "PUT", {
      ids: [left.id],
      action: "unsubscribe",
      target_list_ids: [a],
    });
    check(put.status === 200, "seed-unsubscribe");
    const file = `email,name,attributes\n${address("blocked")},New,\n${address("left")},New,"{""n"":2}"\n`;
    const kept = await run(subscribe([a, b], { subscription_status: "confirmed" }), file);
    check(kept.status === "finished" && kept.imported === 2, "kept");
    let row = await subscriber(address("blocked"));
    check(row.status === "blocklisted", "kept-blocklisted");
    check(membership(row, a) === "unsubscribed", "kept-blocklisted-a");
    check(membership(row, b) === "unsubscribed", "kept-blocklisted-b");
    row = await subscriber(address("left"));
    check(
      row.status === "enabled" && row.name === "Left" && row.attribs.keep === 1,
      "kept-profile",
    );
    check(membership(row, a) === "unsubscribed", "kept-unsubscribed");
    check(membership(row, b) === "confirmed", "kept-new-list");

    // With overwrite, the profile follows the file and a plain unsubscribe is reversed as
    // upstream warns; a blocklisted person stays blocklisted and unsubscribed.
    const replaced = await run(
      subscribe([a], { subscription_status: "confirmed", overwrite: true }),
      file,
    );
    check(replaced.status === "finished", "replaced");
    row = await subscriber(address("blocked"));
    check(row.status === "blocklisted" && row.name === "New", "replaced-blocklisted");
    check(membership(row, a) === "unsubscribed", "replaced-blocklisted-list");
    row = await subscriber(address("left"));
    check(
      row.name === "New" && row.attribs.n === 2 && !("keep" in row.attribs),
      "replaced-profile",
    );
    check(membership(row, a) === "confirmed", "replaced-resubscribed");

    // The two parts of overwrite on their own.
    await run(
      subscribe([a], {
        subscription_status: "unconfirmed",
        overwrite_userinfo: true,
      }),
      `email,name\n${address("left")},Info\n`,
    );
    row = await subscriber(address("left"));
    check(row.name === "Info" && membership(row, a) === "confirmed", "overwrite-userinfo");
    await run(
      subscribe([a], {
        subscription_status: "unconfirmed",
        overwrite_subscription_status: true,
      }),
      `email,name\n${address("left")},Status\n`,
    );
    row = await subscriber(address("left"));
    check(row.name === "Info" && membership(row, a) === "unconfirmed", "overwrite-status");

    // Blocklist mode needs no list, keeps an existing profile and ends every membership.
    const ended = await seed(address("ended"), { lists: [a, b], name: "Ended" });
    const blocklisted = await run(
      { mode: "blocklist", delim: ",", lists: [] },
      `email,name,attributes\n${address("ended")},Ignored,\n${address("newblock")},Fresh,"{""a"":1}"\n`,
    );
    check(blocklisted.status === "finished" && blocklisted.imported === 2, "blocklist");
    row = await subscriber(address("ended"));
    check(row.status === "blocklisted" && row.name === "Ended", "blocklist-existing");
    check(
      membership(row, a) === "unsubscribed" && membership(row, b) === "unsubscribed",
      "b-lists",
    );
    check(ended.id === row.id, "blocklist-same-row");
    row = await subscriber(address("newblock"));
    check(
      row.status === "blocklisted" && row.name === "Fresh" && row.attribs.a === 1,
      "blocklist-new",
    );
    check(row.lists.length === 0, "blocklist-new-lists");

    // Permissions.
    const role = await call("/api/roles/users", "POST", {
      name: `import-${suffix}`,
      permissions: ["subscribers:import"],
    });
    check(role.status === 200, "role");
    roles.push(role.body.data.id);
    const listRole = await call("/api/roles/lists", "POST", {
      name: `import-lists-${suffix}`,
      lists: [{ id: a, permissions: ["list:get", "list:manage"] }],
    });
    check(listRole.status === 200, "list-role");
    roles.push(listRole.body.data.id);
    const token = await call("/api/users", "POST", {
      username: `import-${suffix}`,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
      list_role_id: listRole.body.data.id,
    });
    check(token.status === 200, "scoped-user");
    users.push(token.body.data.id);
    const scoped = {
      authorization: `Basic ${btoa(`${token.body.data.username}:${token.body.data.password}`)}`,
    };
    const none = await call("/api/roles/users", "POST", {
      name: `no-import-${suffix}`,
      permissions: ["subscribers:get"],
    });
    roles.push(none.body.data.id);
    const other = await call("/api/users", "POST", {
      username: `no-import-${suffix}`,
      type: "api",
      status: "enabled",
      user_role_id: none.body.data.id,
    });
    users.push(other.body.data.id);
    const plain = {
      authorization: `Basic ${btoa(`${other.body.data.username}:${other.body.data.password}`)}`,
    };
    check((await call("/api/import/subscribers", "GET", undefined, plain)).status === 403, "perm");
    check((await post(subscribe([a]), "email\n", undefined, plain)).status === 403, "perm-post");
    await refused(
      await post(subscribe([b]), "email\n", undefined, scoped),
      403,
      "Permission denied: lists",
    );
    const started = await post(
      subscribe([a, b], { subscription_status: "confirmed" }),
      `email\n${address("scoped")}\n`,
      undefined,
      scoped,
    );
    check(started.status === 200, "scoped-start");
    await settled();
    await reset();
    row = await subscriber(address("scoped"));
    check(membership(row, a) === "confirmed" && membership(row, b) === undefined, "scoped-filter");

    // One import at a time, and a stop between batches keeps what was written and ends finished.
    const large = (label: string, count: number) =>
      `email\n${Array.from({ length: count }, (_, i) => `${label}${i}.${suffix}@example.test\n`).join("")}`;
    const running = await post(subscribe([a]), large("stop", 40_000));
    check(running.status === 200, "large-start");
    check(running.body.data.status === "importing", "large-importing");
    const second2 = await post(subscribe([a]), "email\n");
    await refused(second2, 400, "already running");
    const stopping = await reset();
    check(stopping.status === 200 && stopping.body.data.status === "stopping", "stopping");
    const stopped = await settled();
    check(stopped.status === "finished", `stopped-${stopped.status}`);
    check(stopped.imported < 40_000, `stopped-partial-${stopped.imported}`);
    check((await logs()).includes("stop request received"), "stop-log");
    check((await reset()).body.data.status === "none", "stopped-reset");

    if (reference) return;

    // ZIP is after v1, and a refused file changes nothing.
    await refused(await post(subscribe([a]), "PK", "subscribers.zip"), 400, "CSV");
    check(JSON.stringify(await status()) === JSON.stringify(IDLE), "zip-idle");

    // The upload limit, declared or not.
    const declared = await new Promise<string>((resolve, reject) => {
      const url = new URL(target.baseUrl);
      const socket = createConnection(Number(url.port), url.hostname);
      let head = "";
      socket.on("data", (data) => {
        head += data.toString();
        socket.destroy();
        resolve(head);
      });
      socket.on("error", reject);
      socket.write(
        `POST /api/import/subscribers HTTP/1.1\r\nHost: x\r\nAuthorization: ${authorization}\r\n` +
          `Content-Type: multipart/form-data; boundary=x\r\nContent-Length: ${110 * 1024 * 1024}\r\n\r\n`,
      );
    });
    check(declared.startsWith("HTTP/1.1 413"), `declared-${declared.slice(0, 20)}`);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const oversized = await fetch(`${target.baseUrl}/api/import/subscribers`, {
      method: "POST",
      headers: { authorization, "content-type": "multipart/form-data; boundary=x" },
      body: new ReadableStream({
        start: (c) =>
          c.enqueue(
            Buffer.from(
              `--x\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\n`,
            ),
          ),
        pull(c) {
          if (++sent > 120) c.close();
          else c.enqueue(chunk);
        },
      }),
    }).catch(() => null);
    check(!oversized || oversized.status === 413, `oversized-${oversized?.status}`);
    check(JSON.stringify(await status()) === JSON.stringify(IDLE), "oversized-idle");
    const temporary = join(target.dataDir!, ".iglo-email-import");
    const drained = async () => {
      for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(20))
        if (!existsSync(temporary) || readdirSync(temporary).length === 0) return true;
      return false;
    };
    check(await drained(), "temporary-empty");

    // Webhooks: blocklist mode queues what the API queues, and repeats queue nothing.
    const receiver = startReceiver();
    const hook = await call("/api/webhooks", "POST", {
      url: receiver.url(),
      events: ["subscriber.blocklisted", "subscriber.unsubscribed"],
    });
    check(hook.status === 200, "hook");
    const hooks = [hook.body.data.id as number];
    try {
      const person = await seed(address("hooked"), { lists: [a] });
      const file = `email\n${address("hooked")}\n${address("hooknew")}\n`;
      const queued = await run({ mode: "blocklist", delim: ",", lists: [] }, file);
      check(queued.status === "finished", "hook-import");
      await receiver.waitFor(3);
      const events = receiver.received.map(
        (r) => `${r.body.event}:${r.body.data.subscriber.email}`,
      );
      check(events.includes(`subscriber.unsubscribed:${address("hooked")}`), "hook-unsubscribed");
      check(events.includes(`subscriber.blocklisted:${address("hooked")}`), "hook-blocklisted");
      check(events.includes(`subscriber.blocklisted:${address("hooknew")}`), "hook-new");
      const unsub = receiver.received.find((r) => r.body.event === "subscriber.unsubscribed")!;
      check(unsub.body.data.subscriber.id === person.id, "hook-subject");
      check(JSON.stringify(unsub.body.data.list_ids) === JSON.stringify([a]), "hook-lists");
      check(receiver.received.length === 3, `hook-count-${receiver.received.length}`);
      await run({ mode: "blocklist", delim: ",", lists: [] }, file);
      await Bun.sleep(200);
      check(receiver.received.length === 3, "hook-repeat");

      // A consent change in subscribe mode queues too.
      const moved = await seed(address("moved"), { lists: [a] });
      await run(
        subscribe([a], { subscription_status: "unsubscribed", overwrite: true }),
        `email\n${address("moved")}\n`,
      );
      await receiver.waitFor(4);
      const last = receiver.received.at(-1)!;
      check(last.body.event === "subscriber.unsubscribed", "hook-subscribe-event");
      check(last.body.data.subscriber.id === moved.id, "hook-subscribe-subject");
      check(membership(await subscriber(address("moved")), a) === "unsubscribed", "moved");

      // Over the budget: 20 webhooks on two events is 40 deliveries a row, so 1,251 rows are over
      // 50,000. The file is refused before anything is written and the import says why.
      for (let i = hooks.length; i < 20; i++) {
        const more = await call("/api/webhooks", "POST", {
          url: receiver.url(),
          events: ["subscriber.blocklisted", "subscriber.unsubscribed"],
        });
        check(more.status === 200, "hook-more");
        hooks.push(more.body.data.id);
      }
      const over = large("budget", 1251);
      const budget = await run({ mode: "blocklist", delim: ",", lists: [] }, over);
      check(budget.status === "failed" && budget.imported === 0, `budget-${budget.status}`);
      check(budget.total === 1251, "budget-total");
      check(budget.log.includes("50,000"), "budget-log");
      check(!(await subscriber(`budget0.${suffix}@example.test`)), "budget-wrote-nothing");
      // A subscribe import that cannot change consent has no budget to meet.
      const free = await run(subscribe([a]), over);
      check(free.status === "finished" && free.imported === 1251, "budget-free");
      // Overwriting status counts who would really leave: 20 deliveries each, so 2,501 is over.
      const many = large("members", 2501);
      check((await run(subscribe([a]), many)).status === "finished", "budget-members");
      const leaving = await run(
        subscribe([a], { subscription_status: "unsubscribed", overwrite: true }),
        many,
      );
      check(leaving.status === "failed" && leaving.imported === 0, "budget-unsubscribe");
      check(leaving.log.includes("50,000"), "budget-unsubscribe-log");
      const member = await subscriber(`members0.${suffix}@example.test`);
      check(membership(member, a) === "unconfirmed", "budget-unsubscribe-wrote-nothing");
      const staying = await run(
        subscribe([a], { subscription_status: "confirmed", overwrite: true }),
        many,
      );
      check(staying.status === "finished", "budget-exact");
    } finally {
      for (const id of hooks) await call(`/api/webhooks/${id}`, "DELETE");
      receiver.close();
    }
    check(await drained(), "temporary-empty-after");
  } finally {
    await call("/api/import/subscribers", "DELETE");
    for (const id of users) await call(`/api/users/${id}`, "DELETE");
    for (const id of roles) {
      await call(`/api/roles/users/${id}`, "DELETE");
      await call(`/api/roles/lists/${id}`, "DELETE");
    }
    await call(`/api/subscribers/query/delete`, "POST", {
      query: `subscribers.email LIKE '%${suffix}@example.test'`,
      list_ids: [],
    });
    for (const id of lists) await call(`/api/lists/${id}`, "DELETE");
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runImportContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS import reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [^\n]+$/.test(error.message) ? error.message : `Import contract failed: ${error}`}\n`,
    );
    process.exitCode = 1;
  }
}
