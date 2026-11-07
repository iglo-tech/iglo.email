// B31 measurement probe (docs/perf/B31-event-tail.md): opt-in, harness-only. `mixed.ts` preloads
// it into the server only when M61_TAIL_PROBE names an output directory; nothing under src/ knows
// about it. It runs the server from source (`bun --preload ... src/main.ts`), brackets every
// synchronous bun:sqlite call, JSON.parse and JSON.stringify with performance.now(), watches GC
// and measures event-loop lateness with a 1 ms timer. Every lateness above LAG_MS is attributed
// to the bracketed work that overlapped it; the rest is "unbracketed" (HTTP, rendering, SMTP
// pipes, template work, timers, other JS). Recording runs from SIGUSR1 to SIGUSR2 (the
// harness's measurement window) and the result is written to <dir>/tail-probe.json on SIGUSR2.
// Not a CI threshold and not for production: it patches prototypes (process-global state).
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";

const dir = process.env.M61_TAIL_PROBE!;
const LAG_MS = Number(process.env.M61_TAIL_LAG_MS ?? 8);
let recording = false;
let windowStart = 0;

type Span = { s: number; e: number; group: string };
const spans: Span[] = [];
const byLabel = new Map<string, { n: number; ms: number; max: number }>();
const gcs: { s: number; e: number; kind: number }[] = [];
const total = (group: string, label: string, s: number, e: number) => {
  if (!recording) return;
  spans.push({ s, e, group });
  const k = `${group} | ${label}`;
  const c = byLabel.get(k) ?? { n: 0, ms: 0, max: 0 };
  c.n++;
  c.ms += e - s;
  c.max = Math.max(c.max, e - s);
  byLabel.set(k, c);
};

// Tables the open transaction has touched decide what its COMMIT is charged to.
let txTables = new Set<string>();
const tableOf = (sql: string) =>
  /\b(?:into|update|from|join)\s+"?([a-z_]+)"?/i.exec(sql)?.[1]?.toLowerCase() ?? "?";
const groupOf = (sql: string, table: string) => {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  if (head.startsWith("BEGIN")) return "begin";
  if (head.startsWith("COMMIT")) {
    const t = [...txTables];
    txTables = new Set();
    const kind = t.includes("events")
      ? "events"
      : t.includes("sends")
        ? "sends"
        : t.includes("campaigns")
          ? "campaigns"
          : t.join("+") || "empty";
    return `commit:${kind}`;
  }
  if (head.startsWith("ROLLBACK") || head.startsWith("SAVEPOINT") || head.startsWith("RELEASE"))
    return "savepoint";
  txTables.add(table);
  if (table === "events") return "sql:events";
  if (/enrollment|sequence/.test(table)) return "sql:sequences";
  if (table === "sends" || table === "outbox") return "sql:sends";
  return "sql:other";
};
const clean = (sql: string) =>
  sql
    .replace(/--[^\n]*\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function timed<A extends unknown[], R>(
  fn: (...a: A) => R,
  sql: string,
  self: unknown,
): (...a: A) => R {
  const text = clean(sql);
  const table = tableOf(text);
  return (...args: A) => {
    if (!recording) return fn.apply(self, args);
    const s = performance.now();
    try {
      return fn.apply(self, args);
    } finally {
      total(groupOf(text, table), text.slice(0, 70), s, performance.now());
    }
  };
}
// `db.query` returns the cached Statement on later calls: wrap each one once.
const wrapped = new WeakSet<object>();
function wrapStatement<T extends object>(stmt: T, sql: string): T {
  if (wrapped.has(stmt)) return stmt;
  wrapped.add(stmt);
  for (const m of ["run", "get", "all", "values"] as const) {
    const original = (stmt as Record<string, unknown>)[m];
    if (typeof original === "function")
      (stmt as Record<string, unknown>)[m] = timed(original as never, sql, stmt);
  }
  return stmt;
}
for (const m of ["query", "prepare"] as const) {
  const original = Database.prototype[m] as (sql: string, ...r: unknown[]) => object;
  (Database.prototype as unknown as Record<string, unknown>)[m] = function (
    this: Database,
    sql: string,
    ...rest: unknown[]
  ) {
    return wrapStatement(original.call(this, sql, ...rest), sql);
  };
}
const originalRun = Database.prototype.run;
Database.prototype.run = function (this: Database, sql: string, ...rest: never[]) {
  return timed(originalRun as never, sql, this)(sql, ...rest);
} as never;
const originalExec = Database.prototype.exec;
Database.prototype.exec = function (this: Database, sql: string, ...rest: never[]) {
  return timed(originalExec as never, sql, this)(sql, ...rest);
} as never;
for (const m of ["parse", "stringify"] as const) {
  const original = JSON[m] as (...a: unknown[]) => unknown;
  (JSON as unknown as Record<string, unknown>)[m] = function (...a: unknown[]) {
    if (!recording) return original.apply(JSON, a);
    const s = performance.now();
    try {
      return original.apply(JSON, a);
    } finally {
      total(`json:${m}`, m, s, performance.now());
    }
  };
}

new PerformanceObserver((list) => {
  if (!recording) return;
  for (const e of list.getEntries()) {
    const d = (e as unknown as { detail?: { kind?: number } }).detail;
    gcs.push({
      s: e.startTime,
      e: e.startTime + e.duration,
      kind: d?.kind ?? -1,
    });
  }
}).observe({ entryTypes: ["gc"] });

const lags: { at: number; late: number }[] = [];
let allLate: number[] = [];
let expected = 0;
const tick = () => {
  const now = performance.now();
  const late = now - expected;
  if (recording) {
    allLate.push(late);
    if (late >= LAG_MS) lags.push({ at: now, late });
  }
  expected = performance.now() + 1;
  setTimeout(tick, 1);
};
expected = performance.now() + 1;
setTimeout(tick, 1);
const histogram = monitorEventLoopDelay({ resolution: 1 });

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

function finish() {
  recording = false;
  histogram.disable();
  // Attribute each late tick: its blocked interval is [at - late, at] (the timer wanted to fire
  // 1 ms after the previous tick; the thread was busy until `at`).
  const share = new Map<string, number>();
  let blocked = 0;
  let lo = 0;
  for (const lag of lags) {
    const from = lag.at - lag.late;
    blocked += lag.late;
    let covered = 0;
    while (lo < spans.length && spans[lo]!.e < from - 5_000) lo++;
    for (let i = lo; i < spans.length; i++) {
      const sp = spans[i]!;
      if (sp.s >= lag.at) break;
      const o = Math.min(sp.e, lag.at) - Math.max(sp.s, from);
      if (o > 0) {
        covered += o;
        share.set(sp.group, (share.get(sp.group) ?? 0) + o);
      }
    }
    for (const g of gcs) {
      const o = Math.min(g.e, lag.at) - Math.max(g.s, from);
      if (o > 0) {
        covered += o;
        share.set("gc", (share.get("gc") ?? 0) + o);
      }
    }
    share.set("unbracketed", (share.get("unbracketed") ?? 0) + Math.max(0, lag.late - covered));
  }
  const groupTotals = new Map<string, { n: number; ms: number; max: number }>();
  for (const [k, v] of byLabel) {
    const g = k.split(" | ")[0]!;
    const c = groupTotals.get(g) ?? { n: 0, ms: 0, max: 0 };
    c.n += v.n;
    c.ms += v.ms;
    c.max = Math.max(c.max, v.max);
    groupTotals.set(g, c);
  }
  const windowMs = performance.now() - windowStart;
  const round = (x: number) => Math.round(x * 100) / 100;
  const out = {
    windowMs: round(windowMs),
    lagThresholdMs: LAG_MS,
    timerLateness: {
      samples: allLate.length,
      p50: round(pct(allLate, 50)),
      p95: round(pct(allLate, 95)),
      p99: round(pct(allLate, 99)),
      p999: round(pct(allLate, 99.9)),
      max: round(Math.max(0, ...allLate)),
    },
    eventLoopDelayHistogramMs: {
      p50: round(histogram.percentile(50) / 1e6),
      p99: round(histogram.percentile(99) / 1e6),
      max: round(histogram.max / 1e6),
    },
    lateTicks: lags.length,
    lateMsTotal: round(blocked),
    lateMsByCause: Object.fromEntries(
      [...share].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v)]),
    ),
    bracketedByGroup: Object.fromEntries(
      [...groupTotals]
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([k, v]) => [k, { n: v.n, ms: round(v.ms), max: round(v.max) }]),
    ),
    bracketedTopLabels: [...byLabel]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 25)
      .map(([k, v]) => ({ k, n: v.n, ms: round(v.ms), max: round(v.max) })),
    gc: {
      n: gcs.length,
      ms: round(gcs.reduce((a, g) => a + g.e - g.s, 0)),
      max: round(Math.max(0, ...gcs.map((g) => g.e - g.s))),
    },
  };
  writeFileSync(join(dir, "tail-probe.json"), JSON.stringify(out, null, 2));
}

process.on("SIGUSR1", () => {
  spans.length = 0;
  byLabel.clear();
  gcs.length = 0;
  lags.length = 0;
  allLate = [];
  txTables = new Set();
  windowStart = performance.now();
  histogram.reset();
  histogram.enable();
  recording = true;
});
process.on("SIGUSR2", finish);
