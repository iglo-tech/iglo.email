// Runs the adapted listmonk Playwright specs in test/e2e/specs. `bun run e2e` builds first.
// With no arguments every spec file runs, spread over E2E_WORKERS independent stacks (default 2):
// each stack is its own server, data directory, SMTP sink and fresh-install instance, and takes
// the next spec file from the queue when it is free. Arguments go to Playwright, as in
// `bun run e2e test/e2e/specs/login.e2e.js`, and then one stack runs them in order.
import { readdir, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, withStacks, type Stack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const results = resolve(root, "dist/e2e-results");
const requested = process.env.E2E_WORKERS ?? "2";
if (!/^[1-9][0-9]*$/.test(requested)) {
  console.error(`E2E_WORKERS must be a whole number of stacks, 1 or more; got "${requested}".`);
  process.exit(2);
}
const workers = Number(requested);

// Longest first, so the big files start early and the short ones fill the gaps. Seconds from a
// run over three stacks; a file missing here runs last. Only the order depends on them, never
// the outcome.
const weights: Record<string, number> = {
  "campaigns.e2e.js": 130,
  "csp.e2e.js": 109,
  "consent.e2e.js": 120,
  "operations.e2e.js": 40,
  "sending.e2e.js": 69,
  "sequences.e2e.js": 107,
  "editor-containment.e2e.js": 96,
  "bounces.e2e.js": 58,
  "webhooks.e2e.js": 48,
  "subscribers-filtered-bulk.e2e.js": 81,
  "subscribers-filtered-bulk-query.e2e.js": 67,
  "settings.e2e.js": 67,
  "subscribers.e2e.js": 65,
  "lists.e2e.js": 61,
  "users.e2e.js": 58,
  "import.e2e.js": 53,
  "campaign-editor.e2e.js": 40,
  "campaign-safety.e2e.js": 39,
  "maintenance.e2e.js": 28,
  "media.e2e.js": 27,
  "templates.e2e.js": 26,
  "forms.e2e.js": 23,
  "captcha.e2e.js": 17,
  "reset.e2e.js": 16,
  "login.e2e.js": 14,
  "dashboard.e2e.js": 12,
  "hostile.e2e.js": 12,
  "twofa.e2e.js": 12,
};

interface Outcome {
  spec: string;
  code: number;
  seconds: number;
  tests: { title: string; seconds: number; status: string }[];
}

/** Serves the mail one stack's sink received to the specs, which run in another process. */
function serveMail(mailbox: Stack["mailbox"]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const to = new URL(request.url).searchParams.get("to");
      const found = mailbox.mails.filter((item) => item.to === to);
      return Response.json(
        found.map((item) => ({
          subject: item.subject,
          body: item.body,
          from: item.header("From"),
          listUnsubscribe: item.header("List-Unsubscribe"),
          listUnsubscribePost: item.header("List-Unsubscribe-Post"),
        })),
      );
    },
  });
}

/** Copies a child's output line by line with a label, so parallel runs stay readable. */
async function relay(stream: ReadableStream<Uint8Array>, label: string) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) console.log(label ? `[${label}] ${line}` : line);
  }
  if (pending) console.log(label ? `[${label}] ${pending}` : pending);
}

interface JsonSuite {
  title: string;
  specs?: { title: string; tests: { results: { duration: number; status: string }[] }[] }[];
  suites?: JsonSuite[];
}

function collect(suite: JsonSuite, path: string[], into: Outcome["tests"]) {
  const here = suite.title.endsWith(".js") || !suite.title ? path : [...path, suite.title];
  for (const spec of suite.specs ?? []) {
    const run = spec.tests.flatMap((test) => test.results);
    into.push({
      title: [...here, spec.title].join(" › "),
      seconds: run.reduce((sum, item) => sum + item.duration, 0) / 1000,
      status: run.at(-1)?.status ?? "unknown",
    });
  }
  for (const child of suite.suites ?? []) collect(child, here, into);
}

async function playwright(
  stack: Stack,
  mailPort: number,
  args: string[],
  name: string,
  label: string,
): Promise<Outcome> {
  const started = performance.now();
  const report = resolve(results, `${name}.json`);
  const child = Bun.spawn(
    [
      resolve(root, "node_modules/.bin/playwright"),
      "test",
      "--config",
      "test/e2e/playwright.config.js",
      "--reporter=list,json",
      "--output",
      resolve(results, name),
      ...args,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        E2E_ORIGIN: stack.origin,
        E2E_DATA_DIR: stack.dataDir,
        E2E_BLANK_ORIGIN: stack.blankOrigin,
        E2E_MAIL: `http://127.0.0.1:${mailPort}`,
        E2E_ADMIN_USER: admin.user,
        E2E_ADMIN_PASSWORD: admin.password,
        PLAYWRIGHT_JSON_OUTPUT_NAME: report,
      },
    },
  );
  const [code] = await Promise.all([
    child.exited,
    relay(child.stdout, label),
    relay(child.stderr, label),
  ]);
  const tests: Outcome["tests"] = [];
  try {
    const parsed = JSON.parse(await readFile(report, "utf8")) as { suites: JsonSuite[] };
    for (const suite of parsed.suites) collect(suite, [], tests);
  } catch {
    // A run that never started a test (a bad argument) has no report; its exit code says enough.
  }
  return { spec: name, code, seconds: (performance.now() - started) / 1000, tests };
}

async function summarise(outcomes: Outcome[], seconds: number, stacks: number) {
  const files = [...outcomes].sort((a, b) => b.seconds - a.seconds);
  const tests = outcomes
    .flatMap((o) => o.tests.map((t) => ({ spec: o.spec, ...t })))
    .sort((a, b) => b.seconds - a.seconds);
  await writeFile(
    resolve(results, "timings.json"),
    JSON.stringify({ stacks, seconds, files, tests }, null, 2),
  );
  console.log(`\nSlowest spec files (${stacks} stack${stacks === 1 ? "" : "s"}):`);
  for (const item of files.slice(0, 15)) {
    console.log(
      `  ${item.seconds.toFixed(0).padStart(5)} s  ${item.tests.length} tests  ${item.spec}`,
    );
  }
  console.log(`Wall time ${(seconds / 60).toFixed(1)} min. Timings: dist/e2e-results/timings.json`);
}

const extra = process.argv.slice(2);
const begin = performance.now();
await rm(results, { recursive: true, force: true });
await mkdir(results, { recursive: true });

process.exitCode = await withStacks(extra.length > 0 ? 1 : workers, async (stacks) => {
  const mails = stacks.map((stack) => serveMail(stack.mailbox));
  try {
    const outcomes: Outcome[] = [];
    if (extra.length > 0) {
      outcomes.push(await playwright(stacks[0]!, mails[0]!.port!, extra, "run", ""));
    } else {
      const specs = (await readdir(resolve(root, "test/e2e/specs")))
        .filter((name) => name.endsWith(".e2e.js"))
        .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a.localeCompare(b));
      await Promise.all(
        stacks.map(async (stack, index) => {
          for (let spec = specs.shift(); spec; spec = specs.shift()) {
            outcomes.push(
              await playwright(
                stack,
                mails[index]!.port!,
                [`test/e2e/specs/${spec}`],
                spec,
                `${index + 1}:${spec.replace(".e2e.js", "")}`,
              ),
            );
          }
        }),
      );
    }
    await summarise(outcomes, (performance.now() - begin) / 1000, stacks.length);
    const failed = outcomes.filter((o) => o.code !== 0);
    for (const item of failed) console.log(`FAILED ${item.spec} (exit ${item.code})`);
    return failed.length > 0 ? 1 : 0;
  } finally {
    for (const mail of mails) await mail.stop(true);
  }
});
