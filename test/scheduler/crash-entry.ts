// Compiled crash fixture: the production scheduler and outbox (test/scheduler/runtime.ts), killed
// with SIGKILL at an explicit barrier named by SCHEDULER_CRASH_AT. Test-only; never shipped.
//   claim   after the claim transaction committed, before the decision is read
//   insert  after the send row is inserted, before the advance, inside the write transaction
//   advance after the advance, before the decision's commit
//   commit  after the decision committed, before the outbox is woken
// The parent kills the process itself for a crash during SMTP delivery.
// With SCHEDULER_CRASH_AT=seed it only seeds the data and the production SMTP setting, then
// exits, so the real production executable can run on the same data directory.
import { createRealClock } from "@/clock";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { createSettings } from "@/settings/store";
import { offsetClock, seed, startRuntime, type Wrap } from "@/test/scheduler/runtime";

const dataDir = process.env.SCHEDULER_CRASH_DIR!;
const smtpPort = Number(process.env.SCHEDULER_CRASH_SMTP_PORT);
const at = process.env.SCHEDULER_CRASH_AT ?? "";
const offset = Number(process.env.SCHEDULER_CRASH_OFFSET_MS ?? 0);
const kill = () => process.kill(process.pid, "SIGKILL");
const barriers: Record<string, [string, string, "before" | "after"]> = {
  claim: ["enrollments", "schedulerContext", "before"],
  insert: ["sends", "recordSequence", "after"],
  advance: ["enrollments", "advance", "after"],
  commit: ["sends", "notify", "before"],
};
const wrap: Wrap = (name, owner) => {
  const barrier = barriers[at];
  if (!barrier || barrier[0] !== name) return owner;
  const [, method, when] = barrier;
  return new Proxy(owner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== method || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (when === "before") kill();
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        kill();
        return result;
      };
    },
  });
};
const seedOnly = at === "seed";
const live = startRuntime({
  dataDir,
  smtpPort,
  clock: offsetClock(createRealClock(), offset),
  wrap,
  ...(seedOnly ? { outbox: false, scheduler: false } : {}),
});
// Enrolling due now wakes the scheduler after this synchronous seed commits.
if (process.env.SCHEDULER_CRASH_SEED === "1")
  seed(live.db, live.enrollments, 1, [
    { wait: "PT0S", kind: "transactional" },
    { wait: "PT0S", kind: "marketing" },
  ]);
if (seedOnly) {
  const lists = createListReferences(live.db);
  const roles = createRoles(live.db, lists);
  const settings = createSettings(live.db, createRealClock(), "http://scheduler.test", roles);
  settings.update((current) => ({
    ...current,
    smtp: [
      {
        ...(current.smtp as Record<string, unknown>[])[0],
        name: "sink",
        enabled: true,
        host: "127.0.0.1",
        port: smtpPort,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      },
    ],
  }));
  settings.close();
  roles.close();
  lists.close();
  await live.close();
  process.exit(0);
}
process.stdout.write("ready\n");
const stop = () => void live.close().then(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
